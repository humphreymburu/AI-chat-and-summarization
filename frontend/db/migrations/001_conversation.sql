-- Saved chat conversations for signed-in users.
-- Messages are stored as the AI SDK UIMessage array (jsonb).
create table if not exists conversation (
  id         text primary key,
  user_id    text not null references "user"(id) on delete cascade,
  title      text not null default 'New conversation',
  messages   jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_user_updated_idx
  on conversation (user_id, updated_at desc);
