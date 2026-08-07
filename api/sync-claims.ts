import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

function jsonError(res: VercelResponse, status: number, message: string) {
  return res.status(status).json({ ok: false, error: message });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const authHeader = req.headers['authorization'];
  const secret = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return jsonError(res, 401, 'Unauthorized');
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    // Fetch only claims that have been modified and need to be synced.
    const { data: claimsToSync, error } = await supabase
      .from('claims')
      .select('*')
      .in('sync_state', ['pending', 'failed']);
    if (error) throw error;

    const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    if (!credentials) {
      return res.status(200).json({ ok: true, synced: 0, note: 'Google service account not configured' });
    }

    if (!claimsToSync || claimsToSync.length === 0) {
      return res.status(200).json({ ok: true, synced: 0, note: 'No new claims to sync.' });
    }

    const serviceAccount = JSON.parse(Buffer.from(credentials, 'base64').toString('utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadSheetIds = {
      battery: process.env.GOOGLE_SHEETS_BATTERY_SPREADSHEET_ID,
      ups: process.env.GOOGLE_SHEETS_UPS_SPREADSHEET_ID,
    };

    const tabNames = {
      battery: {
        all: process.env.GOOGLE_SHEETS_BATTERY_ALL_TAB || 'All Battery Claims',
        open: process.env.GOOGLE_SHEETS_BATTERY_OPEN_TAB || 'Open Battery Claims',
      },
      ups: {
        all: process.env.GOOGLE_SHEETS_UPS_ALL_TAB || 'All UPS Claims',
        open: process.env.GOOGLE_SHEETS_UPS_OPEN_TAB || 'Open UPS Claims',
      },
    };

    const batteryHeaderRow = [['Case Number', 'Customer Name', 'Mobile Number', 'Product Name', 'Product Serial', 'Status', 'Received At', 'Delivered At', 'Added By']];
    const upsHeaderRow = [['Case Number', 'Customer Name', 'Mobile Number', 'Product Name', 'Product Serial', 'Status', 'Received At', 'Delivered At', 'Added By', 'Repair Price', 'Selling Price']];

    const mapBatteryClaimToRow = (claim: any) => [
      claim.case_number ?? '',
      claim.customer_name ?? '',
      claim.mobile_number ?? '',
      claim.product_name ?? '',
      claim.product_serial ?? '',
      claim.status ?? '',
      claim.received_at ? new Date(claim.received_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '',
      claim.delivered_at ? new Date(claim.delivered_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '',
      claim.created_by_name ?? '',
    ];

    const mapUpsClaimToRow = (claim: any) => [
      ...mapBatteryClaimToRow(claim), // Reuse common fields
      claim.ups_details?.repairPrice ?? '',
      claim.ups_details?.sellingPrice ?? '',
    ];

    // Get all existing data from both sheets to find rows that need updating vs. appending.
    const [existingBatterySheet, existingUpsSheet] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: spreadSheetIds.battery, range: tabNames.battery.all }),
      sheets.spreadsheets.values.get({ spreadsheetId: spreadSheetIds.ups, range: tabNames.ups.all }),
    ]);

    const batteryCaseNumberMap = new Map(existingBatterySheet.data.values?.map((row: any[], index: number) => [row[0], index + 1]) || []);
    const upsCaseNumberMap = new Map(existingUpsSheet.data.values?.map((row: any[], index: number) => [row[0], index + 1]) || []);

    let synced = 0;
    for (const type of ['battery', 'ups'] as const) {
      const spreadsheetId = spreadSheetIds[type];
      if (!spreadsheetId) continue;

      const isUps = type === 'ups';
      const mapClaimToRow = isUps ? mapUpsClaimToRow : mapBatteryClaimToRow;
      const claimsForType = claimsToSync.filter((claim: any) => claim.product_type === type);
      if (claimsForType.length === 0) continue;

      const existingCaseMap = type === 'battery' ? batteryCaseNumberMap : upsCaseNumberMap;
      const rowsToUpdate: any[] = [];
      const rowsToAppend: any[] = [];

      for (const claim of claimsForType) {
        const rowData = mapClaimToRow(claim);
        const rowIndex = existingCaseMap.get(claim.case_number);

        if (rowIndex) {
          // If the row exists, prepare it for a batch update.
          rowsToUpdate.push({ range: `${tabNames[type].all}!A${rowIndex}`, values: [rowData] });
        } else {
          // If the row is new, prepare it for appending.
          rowsToAppend.push(rowData);
        }
      }

      // Perform the updates and appends in batches.
      if (rowsToUpdate.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: rowsToUpdate },
        });
      }
      if (rowsToAppend.length > 0) {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: tabNames[type].all,
          valueInputOption: 'RAW',
          requestBody: { values: rowsToAppend },
        });
      }

      // Note: The "Open Claims" sheet logic is still a full rewrite.
      // A similar "upsert" logic could be applied here if performance is critical.
      const openClaims = claimsForType.filter((claim: any) => claim.status !== 'delivered_to_customer');
      const openSheetData = [isUps ? upsHeaderRow[0] : batteryHeaderRow[0], ...openClaims.map(mapClaimToRow)];
      await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabNames[type].open });
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${tabNames[type].open}!A1`, valueInputOption: 'RAW', requestBody: { values: openSheetData } });

      synced += claimsForType.length;
    }

    // After a successful sync, update the state in Supabase.
    const syncedClaimIds = claimsToSync.map((c) => c.id);
    await supabase.from('claims').update({ sync_state: 'synced' }).in('id', syncedClaimIds);

    return res.status(200).json({ ok: true, synced });
  } catch (error) {
    return jsonError(res, 500, error instanceof Error ? error.message : 'Unknown error');
  }
}
