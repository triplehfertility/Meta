-- Run this once in Supabase > SQL Editor

create table if not exists conversations (
  sender_id text primary key,
  history jsonb not null default '[]'::jsonb,
  last_message_time timestamptz not null default now(),
  last_customer_time timestamptz,
  platform text,
  phone_number_id text,
  human_paused_until timestamptz
);

create table if not exists leads (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  platform text,
  sender_id text,
  name text,
  phone text,
  email text,
  service_interest text,
  preferred_time text,
  consultation_mode text,
  appointment_request boolean not null default false,
  notes text,
  status text not null default 'new'
);

create index if not exists leads_sender_idx on leads (sender_id);
create index if not exists conversations_last_idx on conversations (last_message_time);

-- Patient-related data: lock the tables so only the server (service role key) can read or write them.
-- With row level security on and no policies, the public "anon" key can access nothing.
alter table conversations enable row level security;
alter table leads enable row level security;
