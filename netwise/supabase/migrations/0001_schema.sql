-- NetWise schema. All data is fictional demo data. UUID keys, timestamps everywhere.
create extension if not exists pgcrypto;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('employee', 'rep')),
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.employee_profiles (
  user_id uuid primary key references public.users (id) on delete cascade,
  -- base, commissions, bonus, pensionPct, studyFundPct, creditPoints (payroll data: readable and editable by the employee and by reps)
  salary_inputs jsonb not null default '{}'::jsonb,
  group_code text check (group_code in ('א', 'ב', 'ג', 'ד')),
  children_count int check (children_count >= 0),
  occupation text,
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'closed')),
  -- current car, current participation, chosen alternative, rep answers, applied answer ids, last comparison
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  type text not null check (type in ('current', 'alternative')),
  vehicle_ref text, -- catalogue id (CAR-xx), 'waiver', or dataset key
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.calc_results (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references public.scenarios (id) on delete cascade,
  inputs_snapshot jsonb not null,
  result jsonb not null,
  rules_version text not null,
  usage_dataset_version text not null,
  created_at timestamptz not null default now()
);

create table public.rep_questions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  missing_field text not null,
  question_text text not null,
  -- context the representative needs to answer (car label, group). Reps have full access to employee data.
  context jsonb not null default '{}'::jsonb,
  answer text,
  status text not null default 'open' check (status in ('open', 'answered')),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

-- Official usage-value dataset (loaded by scripts/load-usage-values.ts). Key is unique across the dataset.
create table public.vehicles (
  id bigint generated always as identity primary key,
  tax_year int not null,
  reg_year int not null,
  vehicle_type_code text not null,
  maker_code text not null,
  model_code text not null,
  usage_value int not null,
  maker_name text,
  model_description text,
  commercial_name text,
  drive_code int,
  list_price int,
  source_row int,
  constraint vehicles_key unique (tax_year, reg_year, vehicle_type_code, maker_code, model_code)
);

create index vehicles_lookup_idx on public.vehicles (reg_year, maker_code, model_code);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index rep_questions_status_idx on public.rep_questions (status);
create index conversations_user_idx on public.conversations (user_id);
create index scenarios_conversation_idx on public.scenarios (conversation_id);
create index calc_results_scenario_idx on public.calc_results (scenario_id);
