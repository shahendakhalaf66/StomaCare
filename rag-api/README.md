# StomaCare RAG API

This service uses the new backend's existing ChromaDB collection and the exact `sentence-transformers/all-MiniLM-L6-v2` model for both document and query embeddings. It uses only the current Gemini API key for answer generation; it does not import or use the keys from the downloaded project.

## Local run

```bash
cd rag-api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY="your-current-key"
export RAG_API_SECRET="a-long-random-secret"
uvicorn app:app --reload --port 8000
```

`GET /health` checks the service. `POST /v1/chat` accepts `{ "query": "..." }` and returns an answer plus page/section/excerpt citations.

Deploy this service to a Python host such as Render, Railway, Fly.io, or a private VM. Vercel remains the frontend host. Do not deploy the Gemini key to the frontend.
