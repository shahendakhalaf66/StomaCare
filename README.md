# Clinical Clarity

Responsive React starter for a patient-facing medical chatbot, based on the supplied Clinical Clarity reference. It includes a polished responsive UI plus a Supabase schema and Edge Function boundary for Gemini-powered RAG.

## Run the interface

```bash
npm install
cp .env.example .env
npm run dev
```

The UI works in demonstration mode until the Supabase variables are added.

## Connect Supabase + Gemini

1. Create a Supabase project and enable an authentication provider.
2. Install the Supabase CLI, link the project, then run `supabase db push` to apply the migration.
3. Set the server-only Gemini secret: `supabase secrets set GEMINI_API_KEY=...`. The local `.env` key is never exposed by Vite because it has no `VITE_` prefix.
4. Deploy: `supabase functions deploy clinical-chat`.
5. Put the project URL and anon key in `.env` as the `VITE_` variables.

The browser calls only the Edge Function; the Gemini API key and service-role key stay on Supabase. Populate `knowledge_chunks` with reviewed, approved clinical material and 768-dimensional Gemini embeddings before enabling RAG for users.

## Sentence Transformers RAG service

The `rag-api/` service is the new ChromaDB backend. It uses the exact `sentence-transformers/all-MiniLM-L6-v2` model used by the supplied Chroma collection and the current Gemini API for answer generation. Deploy it on a Python host (Render, Railway, Fly.io, or a private VM), then set `RAG_API_URL` and `RAG_API_SECRET` as Supabase Edge Function secrets. The frontend continues to call the existing Supabase `clinical-chat` API; it does not call a Vercel API from the downloaded folder.

## Important clinical guardrails

This is an information assistant, not a diagnostic or emergency service. Before production use, add clinical governance, reviewed content ingestion, audit logging, consent flows, data-retention policies, local regulatory review, testing for emergency escalation, and human clinician handoff.
