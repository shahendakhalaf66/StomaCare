import os
import re
import json
from collections import Counter
from pathlib import Path

# This local service does not need Chroma's anonymous telemetry.
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

import chromadb
USE_FAISS = os.getenv("USE_FAISS", "false").lower() == "true"
import numpy as np
FAISS_AVAILABLE = True
from dotenv import load_dotenv
from chromadb.utils import embedding_functions
from fastapi import FastAPI, Header, HTTPException
from fastapi import Query, Request
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from pydantic import BaseModel, Field
from config import EMBEDDING_MODEL, MIN_AVERAGE_SCORE, MIN_COSINE_SCORE, TOP_K

BASE_DIR = Path(__file__).resolve().parent
CHROMA_DIR = BASE_DIR / "chroma_db_cosine"
CHUNKS_FILE = BASE_DIR / "chunks.json"
FAISS_INDEX_FILE = BASE_DIR / "medical_guidelines.index"
FAISS_METADATA_FILE = BASE_DIR / "medical_guidelines_metadata.json"
VECTOR_FILE = BASE_DIR / "medical_guidelines_vectors.npy"
# Load the API key from rag-api/.env, or reuse the local frontend .env during development.
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR.parent / ".env")
MODEL_NAME = EMBEDDING_MODEL
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
STOP_WORDS = {"a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from", "how", "i", "in", "is", "it", "my", "of", "on", "or", "should", "the", "to", "what", "when", "where", "which", "who", "why", "with", "you"}

app = FastAPI(title="StomaCare RAG API", version="1.0.0")
origins = [item.strip() for item in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,https://ar-olive-eight.vercel.app,https://stomacare-medical.vercel.app").split(",") if item.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"])

client = chromadb.PersistentClient(path=str(CHROMA_DIR))
embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=MODEL_NAME)
collection = client.get_or_create_collection(name="medical_guidelines_v1", embedding_function=embedding_function, metadata={"hnsw:space": "cosine"})

faiss_index = None
faiss_chunks = None
vector_matrix = None
if USE_FAISS and FAISS_INDEX_FILE.exists() and FAISS_METADATA_FILE.exists():
    with FAISS_METADATA_FILE.open(encoding="utf-8") as file:
        faiss_chunks = json.load(file)
    if VECTOR_FILE.exists():
        vector_matrix = np.load(VECTOR_FILE)

if collection.count() == 0:
    if not CHUNKS_FILE.exists():
        raise RuntimeError(f"Missing source chunks file: {CHUNKS_FILE}")
    with CHUNKS_FILE.open("r", encoding="utf-8") as file:
        chunks = json.load(file)
    collection.add(
        ids=[item.get("chunk_id", f"chunk_{index}") for index, item in enumerate(chunks)],
        documents=[item["text"] for item in chunks],
        metadatas=[item.get("metadata", {}) for item in chunks],
    )

class ChatRequest(BaseModel):
    query: str = Field(min_length=2, max_length=4000)

class Source(BaseModel):
    title: str
    page: int | str | None = None
    section: str | None = None
    excerpt: str
    score: float
    cosine_score: float
    meets_threshold: bool

class ChatResponse(BaseModel):
    answer: str
    sources: list[Source]

WHATSAPP_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "").strip()
WHATSAPP_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "").strip()
WHATSAPP_VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "").strip()
WHATSAPP_GRAPH_VERSION = os.getenv("WHATSAPP_GRAPH_VERSION", "v22.0").strip()

def tokenise(text: str) -> Counter:
    return Counter(token for token in re.findall(r"[\w']+", text.lower()) if token not in STOP_WORDS and len(token) > 1)

def source_title(text: str) -> str:
    lowered = text.lower()
    if "helicobacter pylori" in lowered: return "ACG Guideline: Treatment of Helicobacter pylori Infection"
    if "gastro-oesophageal reflux" in lowered or "gord" in lowered: return "NICE CG184: GORD and dyspepsia in adults"
    if "upper gastrointestinal" in lowered or "ulcer bleeding" in lowered: return "ACG Guideline: Upper GI and Ulcer Bleeding"
    if "gastroesophageal reflux disease" in lowered: return "ACG Guideline: Gastroesophageal Reflux Disease"
    return "Reviewed clinical guidelines"

def retrieve_faiss(query: str):
    vector = np.asarray(embedding_function([query]), dtype="float32")
    vector /= np.linalg.norm(vector, axis=1, keepdims=True)
    if vector_matrix is not None:
        scores_all = vector_matrix @ vector[0]
        indices = np.argsort(-scores_all)[:TOP_K]
        scores = scores_all[indices][None, :]
        indices = indices[None, :]
    else:
        raise RuntimeError("FAISS vectors are not available")
    return [{"text": faiss_chunks[int(index)]["text"], "metadata": faiss_chunks[int(index)].get("metadata", {}), "score": float(score), "cosine_score": float(score)} for score, index in zip(scores[0], indices[0]) if index >= 0]

def retrieve(query: str):
    retrieval_query = query
    if "pylori" in query.lower() or "جرثومة المعدة" in query:
        retrieval_query += " H. pylori treatment eradication regimen first-line alternatives test of cure"
    if USE_FAISS and vector_matrix is not None:
        ranked = retrieve_faiss(retrieval_query)
        qualified = [item for item in ranked if item["cosine_score"] >= MIN_COSINE_SCORE]
        if qualified and sum(item["score"] for item in qualified) / len(qualified) >= MIN_AVERAGE_SCORE:
            return qualified
        return []
    raw = collection.query(query_texts=[retrieval_query], n_results=TOP_K, include=["documents", "metadatas", "distances"])
    docs, metadatas, distances = raw["documents"][0], raw["metadatas"][0], raw.get("distances", [[]])[0]
    query_terms = tokenise(query)
    results = []
    for doc, metadata, distance in zip(docs, metadatas, distances):
        doc_terms = tokenise(doc)
        overlap = len(set(query_terms) & set(doc_terms)) / max(len(query_terms), 1)
        score = max(0.0, 1.0 - float(distance))
        results.append({"text": doc, "metadata": metadata or {}, "score": score * 0.75 + overlap * 0.25, "cosine_score": score})
    ranked = sorted(results, key=lambda item: item["score"], reverse=True)
    active_cosine_threshold = MIN_COSINE_SCORE if USE_FAISS else 0.30
    active_average_threshold = MIN_AVERAGE_SCORE if USE_FAISS else 0.25
    qualified = [item for item in ranked if item["cosine_score"] >= active_cosine_threshold]
    if qualified and sum(item["score"] for item in qualified) / len(qualified) >= active_average_threshold:
        return qualified
    return []

def generate_answer(query: str, results: list[dict]) -> str:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key: raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")
    context = "\n\n".join(f"Source {index}: {source_title(item['text'])}, page {item['metadata'].get('page_number', 'unknown')}, section {item['metadata'].get('section_title', 'General')}\n{item['text']}" for index, item in enumerate(results, 1))
    arabic = any("\u0600" <= character <= "\u06ff" for character in query)
    language_instruction = """اكتب الإجابة بالعربية الفصحى الواضحة بالكامل. ترجم الشرح والعناوين، ويمكن إبقاء أسماء الإرشادات والأدوية والاختصارات الطبية بالإنجليزية بين قوسين عند الحاجة. لا تخلط بين العربية والإنجليزية إلا للمصطلح الطبي أو اسم المصدر.""" if arabic else "Answer in the same language as the question."
    prompt = f"""You are StomaCare, a retrieval-grounded medical guideline assistant. Answer ONLY from the excerpts below; if a requested detail is not supported, say so. Never invent a diagnosis, dose, duration, or prescription.

For treatment questions about H. pylori, structure the answer with these four headings when supported by the excerpts. Give a complete, useful explanation (around 700–900 words when the excerpts support it), and make sure the response reaches the fourth heading before ending:
1. First-line regimen and duration (state the preferred regimen for treatment-naive adults when antibiotic susceptibility is unknown).
2. Alternatives or salvage options, including how prior antibiotic exposure, resistance testing, or penicillin allergy changes selection.
3. Test of cure: timing, accepted tests, and medicines that must be held before testing.
4. Safety and clinician follow-up.
Clearly distinguish guideline recommendations from general context. Include the guideline name and page number beside each key claim when available. Do not provide a personalized prescription. {language_instruction} End with a short statement that this is information, not a substitute for a clinician.

Question:
{query}

Retrieved excerpts:
{context}"""
    response = genai.Client(api_key=api_key).models.generate_content(model=GEMINI_MODEL, contents=prompt, config={"temperature": 0.2, "max_output_tokens": 5000})
    return (response.text or "I could not generate an answer from the available guidelines.").strip()

def validate_claim_citations(answer: str, results: list[dict]) -> bool:
    """Reject explicit page citations that are not in the retrieved evidence."""
    retrieved_pages = {str(item["metadata"].get("page_number")) for item in results}
    cited_pages = set(re.findall(r"(?:page|p\.)\s*(\d+)", answer, re.IGNORECASE))
    return not cited_pages or cited_pages.issubset(retrieved_pages)

def send_whatsapp_message(recipient: str, text: str) -> None:
    if not WHATSAPP_TOKEN or not WHATSAPP_PHONE_NUMBER_ID:
        raise HTTPException(status_code=503, detail="WhatsApp Cloud API is not configured")
    import httpx
    url = f"https://graph.facebook.com/{WHATSAPP_GRAPH_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages"
    response = httpx.post(url, headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"}, json={"messaging_product": "whatsapp", "to": recipient, "type": "text", "text": {"preview_url": False, "body": text[:4096]}}, timeout=20)
    if response.is_error:
        raise HTTPException(status_code=502, detail="WhatsApp message delivery failed")

@app.get("/webhooks/whatsapp")
def verify_whatsapp_webhook(mode: str | None = Query(default=None, alias="hub.mode"), token: str | None = Query(default=None, alias="hub.verify_token"), challenge: str | None = Query(default=None, alias="hub.challenge")):
    if mode == "subscribe" and token and token == WHATSAPP_VERIFY_TOKEN and challenge:
        return int(challenge)
    raise HTTPException(status_code=403, detail="Webhook verification failed")

@app.post("/webhooks/whatsapp")
def receive_whatsapp_webhook(request: Request):
    import asyncio
    payload = asyncio.run(request.json())
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            for message in value.get("messages", []):
                if message.get("type") != "text":
                    continue
                sender = message.get("from")
                text = message.get("text", {}).get("body", "").strip()
                if not sender or not text:
                    continue
                results = retrieve(text)
                if results:
                    answer = generate_answer(text, results)
                    if not validate_claim_citations(answer, results):
                        answer = "I could not verify the citations for this response. Please consult a clinician."
                else:
                    answer = "I could not find sufficiently relevant guideline evidence for this question. Please rephrase it or consult a clinician."
                send_whatsapp_message(sender, answer)
    return {"status": "ok"}

@app.get("/health")
def health(): return {"status": "ok", "embedding_model": MODEL_NAME, "collection": collection.name}

@app.get("/")
def root():
    return {"service": "StomaCare RAG API", "status": "ok", "docs": "/docs", "health": "/health"}

@app.post("/v1/chat", response_model=ChatResponse)
def chat(request: ChatRequest, x_rag_secret: str | None = Header(default=None)):
    expected = os.getenv("RAG_API_SECRET", "").strip()
    if expected and x_rag_secret != expected: raise HTTPException(status_code=401, detail="Invalid RAG API secret")
    lowered = request.query.casefold()
    if any(term in lowered for term in ("chest pain", "shortness of breath", "severe bleeding", "suicid", "ألم شديد", "ضيق التنفس", "نزيف شديد")):
        return ChatResponse(answer="This may be an emergency. Contact local emergency services or seek urgent medical care now.", sources=[])
    results = retrieve(request.query)
    if not results:
        return ChatResponse(answer="I could not find sufficiently relevant guideline evidence for this question. Please rephrase it or consult a clinician.", sources=[])
    sources = [Source(title=source_title(item["text"]), page=item["metadata"].get("page_number"), section=item["metadata"].get("section_title"), excerpt=re.sub(r"\s+", " ", item["text"])[:240], score=round(item["score"], 3), cosine_score=round(item["cosine_score"], 3), meets_threshold=True) for item in results]
    answer = generate_answer(request.query, results)
    if not validate_claim_citations(answer, results):
        return ChatResponse(answer="I could not verify every citation in the generated answer against the retrieved guideline pages. Please rephrase the question or consult a clinician.", sources=sources)
    return ChatResponse(answer=answer, sources=sources)
