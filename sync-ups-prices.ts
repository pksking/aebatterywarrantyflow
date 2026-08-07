import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

function jsonError(res: VercelResponse, status: number, message: string) {
  return res.status(status).json({ ok: false, error: message });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  const secret = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return jsonError(res, 401, 'Unauthorized');
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { data: upsModels, error } = await supabase.from('ups_models').select('*').order('model_name', { ascending: true });
    if (error) throw error;

    const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    if (!credentials) {
      return res.status(200).json({ ok: true, synced: 0, note: 'Google service account not configured' });
    }

    if (!upsModels || upsModels.length === 0) {
      return res.status(200).json({ ok: true, synced: 0, note: 'No UPS models to sync.' });
    }

    const serviceAccount = JSON.parse(Buffer.from(credentials, 'base64').toString('utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_UPS_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(200).json({ ok: true, synced: 0, note: 'UPS spreadsheet ID not configured.' });
    }

    const tabName = process.env.GOOGLE_SHEETS_UPS_PRICES_TAB || 'UPS Prices';

    const headerRow = [['Model Name', 'Repair Price', 'Selling Price', 'Last Updated']];
    const rows = upsModels.map((model: any) => [
      model.model_name,
      model.repair_price,
      model.selling_price,
      new Date(model.updated_at).toLocaleString('en-IN'),
    ]);

    const sheetData = [headerRow[0], ...rows];

    // Clear the existing sheet data
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName });

    // Update the sheet with the new data
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: sheetData },
    });

    return res.status(200).json({ ok: true, synced: upsModels.length });
  } catch (error) {
    return jsonError(res, 500, error instanceof Error ? error.message : 'Unknown error');
  }
}