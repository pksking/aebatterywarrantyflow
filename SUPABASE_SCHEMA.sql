-- Store registered team members (mirrors auth.users) so the app can list
-- all admins & staff in the member and reminder sections.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role text not null default 'staff',
  push_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_select_all on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

create policy profiles_select_all on public.profiles for select using (true);
create policy profiles_insert_own on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update_own on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create table if not exists public.claims (
  id text primary key,
  case_number text not null,
  product_type text not null,
  product_serial text not null,
  scan_payload text,
  product_name text not null,
  customer_name text not null,
  mobile_number text not null,
  slip_number text not null,
  complaint text default '',
  status text not null default 'with_us',
  cleared boolean not null default false,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  delivered_at timestamptz,
  reminder_due_at timestamptz not null default now(),
  reminder_every_days integer not null default 3,
  previous_claim_id text,
  replacement_serial text,
  replacement_product_name text,
  battery_details jsonb,
  ups_details jsonb,
  attachments jsonb,
  sync_state text not null default 'pending'
);

create table if not exists public.warranty_exchanges (
  id uuid primary key default gen_random_uuid(),
  claim_id text not null references public.claims(id) on delete cascade,
  old_product_serial text not null,
  new_product_serial text not null,
  new_product_name text not null,
  delivered_to_customer boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.claims enable row level security;
alter table public.warranty_exchanges enable row level security;

-- Helper function to get the role of the currently authenticated user
create or replace function get_current_user_role()
returns text
language sql
security definer
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Drop existing policies before creating new ones

drop policy if exists claims_select_all on public.claims;
drop policy if exists claims_insert_all on public.claims;
drop policy if exists claims_update_all on public.claims;
drop policy if exists exchanges_select_all on public.warranty_exchanges;
drop policy if exists exchanges_insert_all on public.warranty_exchanges;
drop policy if exists exchanges_update_all on public.warranty_exchanges;

-- Anyone can view claims.
create policy claims_select_all on public.claims for select using (true);

-- Any authenticated user can create a claim.
create policy claims_insert_all on public.claims for insert with check (auth.role() = 'authenticated');

-- Any authenticated user can update a claim.
-- For more security, you could restrict this to 'admin' or the user who created it.
create policy claims_update_all on public.claims for update using (auth.role() = 'authenticated') with check (true);

-- Anyone can view exchanges.
create policy exchanges_select_all on public.warranty_exchanges for select using (true);

-- Any authenticated user can create an exchange record.
create policy exchanges_insert_all on public.warranty_exchanges for insert with check (auth.role() = 'authenticated');

-- Only admins can update exchange records (as an example of a stricter policy).
create policy exchanges_update_all on public.warranty_exchanges for update using (get_current_user_role() = 'admin') with check (true);
