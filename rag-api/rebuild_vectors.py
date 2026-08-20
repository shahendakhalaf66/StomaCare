import json
from pathlib import Path
import numpy as np
from sentence_transformers import SentenceTransformer

BASE = Path(__file__).parent
chunks = json.loads((BASE / "chunks.json").read_text(encoding="utf-8"))
model = SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
texts = [item["text"] for item in chunks]
vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=True)
np.save(BASE / "medical_guidelines_vectors.npy", np.asarray(vectors, dtype=np.float32))
(BASE / "medical_guidelines_metadata.json").write_text(json.dumps([{"text": item["text"], "metadata": item.get("metadata", {})} for item in chunks], ensure_ascii=False), encoding="utf-8")
print(f"Rebuilt {len(texts)} vectors with dimension {vectors.shape[1]}")
