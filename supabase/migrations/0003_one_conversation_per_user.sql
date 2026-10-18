-- One conversation per user. getOrCreateConversation relies on it; without the constraint, concurrent creates
-- could produce duplicates. If this fails with a duplicate-key error, the dev DB already holds duplicates:
-- delete the extras (or reset the dev DB) and push again.
create unique index conversations_user_unique on public.conversations (user_id);
drop index if exists public.conversations_user_idx; -- superseded by the unique index
