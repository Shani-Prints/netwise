-- Row Level Security. Designed for Supabase Auth (auth.uid() = users.id), which can replace the demo cookie session.
-- Access model: an employee reaches only her own rows; a rep may read and modify all employees' data.
-- Both roles are read-only on vehicles; users is read-only for the rep.
-- NOTE: the demo server uses the service-role key, which bypasses RLS; there the same rules are enforced in
-- application code (src/lib/service.ts + route handlers). These policies protect any direct client access.

alter table public.users enable row level security;
alter table public.employee_profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.scenarios enable row level security;
alter table public.calc_results enable row level security;
alter table public.rep_questions enable row level security;
alter table public.vehicles enable row level security;

create or replace function public.current_app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.users where id = auth.uid()
$$;

create or replace function public.owns_conversation(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations c where c.id = cid and c.user_id = auth.uid())
$$;

-- users: everyone sees only their own row
create policy users_self on public.users for select using (id = auth.uid());

-- employees read/write only their own rows (rep policies for full access follow below).
create policy profiles_own on public.employee_profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy conversations_own on public.conversations for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy messages_own on public.messages for all using (public.owns_conversation(conversation_id))
  with check (public.owns_conversation(conversation_id));
create policy scenarios_own on public.scenarios for all using (public.owns_conversation(conversation_id))
  with check (public.owns_conversation(conversation_id));
create policy calc_results_own on public.calc_results for select using (
  exists (select 1 from public.scenarios s where s.id = scenario_id and public.owns_conversation(s.conversation_id))
);

-- rep_questions: employees see their own; representatives see all questions
create policy rep_questions_employee on public.rep_questions for select using (public.owns_conversation(conversation_id));
create policy rep_questions_rep on public.rep_questions for select using (public.current_app_role() = 'rep');

-- Representatives: read and modify all employees' data (users is read-only).
create policy users_rep on public.users
  for select using (public.current_app_role() = 'rep');

create policy profiles_rep on public.employee_profiles
  for all using (public.current_app_role() = 'rep')
  with check (public.current_app_role() = 'rep');
create policy conversations_rep on public.conversations
  for all using (public.current_app_role() = 'rep')
  with check (public.current_app_role() = 'rep');
create policy messages_rep on public.messages
  for all using (public.current_app_role() = 'rep')
  with check (public.current_app_role() = 'rep');
create policy scenarios_rep on public.scenarios
  for all using (public.current_app_role() = 'rep')
  with check (public.current_app_role() = 'rep');
create policy calc_results_rep on public.calc_results
  for all using (public.current_app_role() = 'rep')
  with check (public.current_app_role() = 'rep');
create policy rep_questions_rep_write on public.rep_questions
  for all using (public.current_app_role() = 'rep')
  with check (public.current_app_role() = 'rep');

-- Representatives answer through a function so they can change nothing but the answer fields.
create or replace function public.answer_rep_question(qid uuid, ans text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() <> 'rep' then raise exception 'only a representative may answer'; end if;
  update public.rep_questions set answer = ans, status = 'answered', answered_at = now()
  where id = qid and status = 'open';
end $$;
revoke all on function public.answer_rep_question(uuid, text) from public;
grant execute on function public.answer_rep_question(uuid, text) to authenticated;

-- reference data: readable by any signed-in user
create policy vehicles_read on public.vehicles for select using (auth.role() = 'authenticated');
