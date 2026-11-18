-- AI assistant connections: an administrator-controlled install setting, off
-- by default, and the two tables behind it.
--
-- * app_settings.assistant_connections: whether senders may connect an AI
--   assistant (an MCP client such as Claude) to prepare drafts for them.
--   Turning it off ends every connection.
-- * assistant_connections: one row per sender and assistant they approved.
--   Times are in seconds.
-- * assistant_upload_requests: a single-use, short-lived link an assistant
--   hands the sender to upload a document. Only the hash of the token is
--   kept. The envelope it made is kept for reference and cleared if the
--   envelope is deleted.

alter table public.app_settings
  add column if not exists assistant_connections boolean not null default false;

create table if not exists public.assistant_connections (
  user_id text not null references public."user" (id) on delete cascade,
  client_id text not null,
  client_name text not null,
  approved_at bigint not null,
  last_used_at bigint,
  primary key (user_id, client_id)
);

create table if not exists public.assistant_upload_requests (
  id text primary key,
  token_hash text not null unique,
  user_id text references public."user" (id) on delete cascade,
  client_id text not null,
  client_name text not null,
  title text not null,
  created_at bigint not null,
  expires_at bigint not null,
  used_at bigint,
  envelope_id text references public.envelopes (id) on delete set null
);
