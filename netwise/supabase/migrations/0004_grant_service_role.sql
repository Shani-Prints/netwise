-- The server connects with the service role (bypasses RLS, but not table privileges).
-- Grants go to service_role only: anon / authenticated get nothing here, so there is no direct client access.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
-- keep future tables/functions covered
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
