import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { google } from 'https://esm.sh/googleapis@105'; // Use a specific version for stability
import { corsHeaders } from '../_shared/cors.ts';

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  const authHeader = req.headers.get('authorization');
  if (Deno.env.get('CRON_SECRET') && authHeader !== `Bearer ${Deno.env.get('CRON_SECRET')}`) {
    return jsonError(401, 'Unauthorized');
  }

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: claimsToSync, error } = await supabase
      .from('claims')
      .select('*')
      .in('sync_state', ['pending', 'failed']);
    if (error) throw error;

    const credentials = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');
    if (!credentials) {
      return new Response(JSON.stringify({ ok: true, synced: 0, note: 'Google service account not configured' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!claimsToSync || claimsToSync.length === 0) {
      return new Response(JSON.stringify({ ok: true, synced: 0, note: 'No new claims to sync.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const serviceAccount = JSON.parse(atob(credentials));
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadSheetIds = {
      battery: Deno.env.get('GOOGLE_SHEETS_BATTERY_SPREADSHEET_ID'),
      ups: Deno.env.get('GOOGLE_SHEETS_UPS_SPREADSHEET_ID'),
    };

    const tabNames = {
      battery: {
        all: Deno.env.get('GOOGLE_SHEETS_BATTERY_ALL_TAB') || 'All Battery Claims',
        open: Deno.env.get('GOOGLE_SHEETS_BATTERY_OPEN_TAB') || 'Open Battery Claims',
      },
      ups: {
        all: Deno.env.get('GOOGLE_SHEETS_UPS_ALL_TAB') || 'All UPS Claims',
        open: Deno.env.get('GOOGLE_SHEETS_UPS_OPEN_TAB') || 'Open UPS Claims',
      },
    };

    const batteryHeaderRow = [['Case Number', 'Customer Name', 'Mobile Number', 'Product Name', 'Product Serial', 'Status', 'Received At', 'Delivered At', 'Added By']];
    const upsHeaderRow = [['Case Number', 'Customer Name', 'Mobile Number', 'Product Name', 'Product Serial', 'Status', 'Received At', 'Delivered At', 'Added By', 'Repair Price', 'Selling Price']];

    const mapBatteryClaimToRow = (claim: any) => [
      claim.case_number ?? '', claim.customer_name ?? '', claim.mobile_number ?? '', claim.product_name ?? '', claim.product_serial ?? '', claim.status ?? '',
      claim.received_at ? new Date(claim.received_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '',
      claim.delivered_at ? new Date(claim.delivered_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '',
      claim.created_by_name ?? '',
    ];

    const mapUpsClaimToRow = (claim: any) => [...mapBatteryClaimToRow(claim), claim.ups_details?.repairPrice ?? '', claim.ups_details?.sellingPrice ?? ''];

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
          rowsToUpdate.push({ range: `${tabNames[type].all}!A${rowIndex}`, values: [rowData] });
        } else {
          rowsToAppend.push(rowData);
        }
      }

      if (rowsToUpdate.length > 0) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: rowsToUpdate } });
      if (rowsToAppend.length > 0) await sheets.spreadsheets.values.append({ spreadsheetId, range: tabNames[type].all, valueInputOption: 'RAW', requestBody: { values: rowsToAppend } });

      const openClaims = claimsForType.filter((claim: any) => claim.status !== 'delivered_to_customer');
      const openSheetData = [isUps ? upsHeaderRow[0] : batteryHeaderRow[0], ...openClaims.map(mapClaimToRow)];
      await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabNames[type].open });
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${tabNames[type].open}!A1`, valueInputOption: 'RAW', requestBody: { values: openSheetData } });

      synced += claimsForType.length;
    }

    const syncedClaimIds = claimsToSync.map((c) => c.id);
    await supabase.from('claims').update({ sync_state: 'synced' }).in('id', syncedClaimIds);

    return new Response(JSON.stringify({ ok: true, synced }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : 'Unknown error');
  }
});
