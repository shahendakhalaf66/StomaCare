drop function if exists public.match_knowledge_chunks(vector, int);

create function public.match_knowledge_chunks(query_embedding vector(768), match_count int default 5)
returns table (id uuid, content text, source_title text, source_url text, metadata jsonb, similarity float)
language sql stable as $$
  select id, content, source_title, source_url, metadata, 1 - (embedding <=> query_embedding) as similarity
  from public.knowledge_chunks
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
