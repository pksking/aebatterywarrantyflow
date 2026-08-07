# WarrantyFlow

## Local setup

1. Copy .env.example to .env and fill in the real values.
2. Apply the SQL in SUPABASE_SCHEMA.sql to your Supabase project.
3. Run `npm install`.
4. Start the app with `npm start`.

## Backend sync

The app calls `/api/sync-claims` after creating or updating claims. Deploy the project to Vercel to enable the Google Sheets export flow.
