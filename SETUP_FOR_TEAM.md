# StomaCare – Team Setup

## Requirements

- Node.js 20 or newer
- npm 10 or newer

## Frontend

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`.

Set the values in `.env` before testing:

```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_RAG_API_URL=http://localhost:8000
VITE_WHATSAPP_ENGINE_URL=http://localhost:3001
VITE_ADMIN_EMAILS=admin1@stomacare.com
```

## RAG API (optional local backend)

```bash
cd rag-api
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn app:app --reload --port 8000
```

The repository includes the generated FAISS index and metadata, so no vector rebuild is needed for the first run.

## WhatsApp engine (optional)

```bash
cd whatsapp-engine
npm install
cp env.example .env
npm run dev
```

The engine runs on port 3001. Use the admin account in the frontend to open the WhatsApp QR connection panel.

## Notes

- Never commit `.env` files or production API keys.
- `node_modules`, `dist`, local caches, and deployment metadata are intentionally excluded from the shared archive.
