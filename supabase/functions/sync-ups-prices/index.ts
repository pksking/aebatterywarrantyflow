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
    const { data: upsModels, error } = await supabase.from('ups_models').select('*').order('model_name', { ascending: true });
    if (error) throw error;

    const credentials = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');
    if (!credentials) {
      return new Response(JSON.stringify({ ok: true, synced: 0, note: 'Google service account not configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!upsModels || upsModels.length === 0) {
      return new Response(JSON.stringify({ ok: true, synced: 0, note: 'No UPS models to sync.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const serviceAccount = JSON.parse(atob(credentials));
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = Deno.env.get('GOOGLE_SHEETS_UPS_SPREADSHEET_ID');
    if (!spreadsheetId) {
      return new Response(JSON.stringify({ ok: true, synced: 0, note: 'UPS spreadsheet ID not configured.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const tabName = Deno.env.get('GOOGLE_SHEETS_UPS_PRICES_TAB') || 'UPS Prices';
    const headerRow = [['Model Name', 'Repair Price', 'Selling Price', 'Last Updated']];
    const rows = upsModels.map((model: any) => [model.model_name, model.repair_price, model.selling_price, new Date(model.updated_at).toLocaleString('en-IN')]);
    const sheetData = [headerRow[0], ...rows];

    await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${tabName}!A1`, valueInputOption: 'RAW', requestBody: { values: sheetData } });

    return new Response(JSON.stringify({ ok: true, synced: upsModels.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : 'Unknown error');
  }
});
