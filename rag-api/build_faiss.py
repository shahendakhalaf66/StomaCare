import json
from pathlib import Path

import faiss
import numpy as np
from chromadb.utils import embedding_functions

BASE_DIR = Path(__file__).resolve().parent
chunks = json.loads((BASE_DIR / "chunks.json").read_text(encoding="utf-8"))
model_name = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=model_name)
vectors = np.asarray(embedding_function([item["text"] for item in chunks]), dtype="float32")
faiss.normalize_L2(vectors)
index = faiss.IndexFlatIP(vectors.shape[1])
index.add(vectors)
faiss.write_index(index, str(BASE_DIR / "medical_guidelines.index"))
(BASE_DIR / "medical_guidelines_metadata.json").write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
print(f"Built FAISS index: {index.ntotal} chunks, {vectors.shape[1]} dimensions")
