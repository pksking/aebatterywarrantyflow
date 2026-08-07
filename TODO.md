# Migration: Vercel Serverless → Supabase Edge Functions

## Steps
- [x] Understand codebase & approve plan
- [ ] Create `supabase/functions/sync-claims/index.ts`
- [ ] Create `supabase/functions/sync-ups-prices/index.ts`
- [ ] Update `supabase/config.toml` with new function configs
- [ ] Update `App.tsx` `runSyncClaims` and `runSyncUpsPrices` to call Supabase functions

## Follow-up (manual)
- [ ] Deploy functions: `supabase functions deploy sync-claims` and `supabase functions deploy sync-ups-prices`
- [ ] Set Supabase secrets (CRON_SECRET, service account, spreadsheet IDs)
- [ ] Add `EXPO_PUBLIC_SUPABASE_PROJECT_REF` and `EXPO_PUBLIC_CRON_SECRET` env vars
