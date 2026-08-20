-- Run with: supabase db push (or paste into the Supabase SQL editor).
create extension if not exists vector;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New consultation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- Knowledge chunks created from reviewed medical content only. Do not use patient data as RAG material.
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  source_title text not null,
  source_url text,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(768),
  created_at timestamptz not null default now()
);
create index knowledge_chunks_embedding_idx on public.knowledge_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.knowledge_chunks enable row level security;

create policy "Users manage their own conversations" on public.conversations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users access messages in their conversations" on public.messages for all using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())) with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));
-- Knowledge reads happen only in the server-side Edge Function using the service role.

create or replace function public.match_knowledge_chunks(query_embedding vector(768), match_count int default 5)
returns table (id uuid, content text, source_title text, source_url text, similarity float)
language sql stable as $$
  select id, content, source_title, source_url, 1 - (embedding <=> query_embedding) as similarity
  from public.knowledge_chunks
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
