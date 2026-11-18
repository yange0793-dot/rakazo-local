#!/usr/bin/env python3
"""Authenticated, loopback-only candidate index over the installed local backend.

The authority store owns facts, revisions, tombstones and scope authorization.
This process returns only candidate ids/revisions/scores, never indexed content.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 256 * 1024
MAX_TEXT_BYTES = 40 * 1024
MAX_CANDIDATES = 50
RRF_OFFSET = 60
MAX_REVISION = 2**53 - 1
COLLECTION = "rakazo-semantic-index-v1"
OWNER_FILE = ".rakazo-local-memory-index"
PROJECTION_FILE = ".rakazo-lexical-projection"
PROJECTION_VERSION = "cjk-bigram-v1\n"
PROJECTION_PAGE = 200
# Both legs score every candidate inside their own top-k, so without a floor RRF returns
# unrelated facts for any query. Measured with the cached embeddinggemma model: unrelated queries
# peak at 0.568 against real stored facts and at 0.615 against a synthetic varied corpus, while
# relevant queries reach 0.61–0.87. 0.60 keeps those and still drops the unrelated band. The
# lexical leg has no comparable floor: the same exact identifier measures 0.69 BM25 in a 3-fact
# index and 3.22 in a 6-fact one, while a coincidental bigram reached 5.72 on a 39-fact index, so
# any lexical cutoff would either drop exact identifiers or keep the noise.
MIN_VECTOR_SIMILARITY = 0.60
TOKEN_RE = re.compile(r"[A-Za-z0-9._~+/\-]{32,512}\Z")
MINILM_FILES = (
    "config.json", "model.onnx", "special_tokens_map.json",
    "tokenizer_config.json", "tokenizer.json", "vocab.txt",
)
GEMMA_REPO = "onnx-community/embeddinggemma-300m-ONNX"


class InvalidRequest(ValueError):
    pass


def text_field(data: dict, key: str, max_bytes: int) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise InvalidRequest(f"Invalid {key}.")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError as exc:
        raise InvalidRequest(f"Invalid {key}.") from exc
    if size > max_bytes:
        raise InvalidRequest(f"{key} is too large.")
    return value


def fields(data: object, names: set[str]) -> dict:
    if not isinstance(data, dict) or set(data) != names:
        raise InvalidRequest("Invalid request fields.")
    return data


def revision_field(data: dict) -> int:
    revision = data.get("revision")
    if type(revision) is not int or revision < 1 or revision > MAX_REVISION:
        raise InvalidRequest("Invalid revision.")
    return revision


# Languages written without spaces between words reach the FTS5 whitespace tokenizer as one
# oversized token, so both the document and the query add their overlapping 2-character runs.
CJK_RUN = re.compile(
    "[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f]+"
)


def lexical_text(text: str) -> str:
    """The text with every CJK run replaced by its space-separated 2-character runs.

    Spaces are what the unicode61 tokenizer splits on, and a run without them reaches it as one
    oversized token that no ordinary query matches. Replacement, rather than appending, keeps
    the function idempotent: every emitted token is a 2-character run that maps to itself, so
    the startup migration is safe to rerun.
    """

    def grams(match: re.Match) -> str:
        run = match.group(0)
        return " ".join([run] if len(run) == 1 else [run[index : index + 2] for index in range(len(run) - 1)])

    return CJK_RUN.sub(grams, text)


def validate_palace_path(path: Path) -> Path:
    if not path.expanduser().is_absolute():
        raise ValueError("palace-dir must be an explicit absolute path.")
    resolved = path.expanduser().resolve()
    # Original assistant palaces/default configuration are never adapter targets.
    if any(part.lower() in {"claudebot", ".claudebot", ".mempalace"} for part in resolved.parts):
        raise ValueError("Original assistant memory directories are not permitted.")
    if resolved == Path(resolved.anchor) or resolved == Path.home():
        raise ValueError("palace-dir must be a dedicated new directory.")
    return resolved


def prepare_palace_dir(path: Path, model: str) -> Path:
    palace = validate_palace_path(path)
    expected = f"rakazo-local-memory-index-v1\nembedding-model={model}\n"
    if palace.exists():
        if not palace.is_dir():
            raise ValueError("palace-dir must be a directory.")
        if any(item.is_symlink() for item in palace.iterdir()):
            raise ValueError("Index directory must not contain symlinks.")
        if any(palace.iterdir()):
            marker = palace / OWNER_FILE
            if not marker.is_file() or marker.read_text(encoding="utf-8") != expected:
                raise ValueError("Nonempty palace-dir is not owned by this index/model.")
            return palace
    palace.mkdir(mode=0o700, parents=True, exist_ok=True)
    palace.chmod(0o700)
    # A marker allows restart, not arbitrary existing-palace adoption or model swaps.
    with (palace / OWNER_FILE).open("x", encoding="utf-8") as marker:
        marker.write(expected)
    return palace


def read_token(path: Path) -> str:
    candidate = path.expanduser()
    if not candidate.is_absolute() or candidate.is_symlink():
        raise ValueError("token-file must be an explicit non-symlink absolute path.")
    info = candidate.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError("token-file must be a private regular file owned by this user (0600).")
    if info.st_size > 1024:
        raise ValueError("token-file is too large.")
    token = candidate.read_text(encoding="utf-8").strip()
    if not TOKEN_RE.fullmatch(token):
        raise ValueError("token-file must contain a 32–512 character bearer token.")
    return token


def configure_offline(palace: Path, cache: Path) -> None:
    os.environ["MEMPALACE_CONFIG_DIR"] = str(palace / "config")
    os.environ["HF_HUB_CACHE"] = str(cache)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["ANONYMIZED_TELEMETRY"] = "False"


def load_cached_embedder(model: str, cache: Path):
    """Lazy inference, cache-only loading; never call an upstream model downloader."""
    os.environ["HF_HUB_CACHE"] = str(cache)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if not cache.is_dir():
        raise ValueError("cache-dir must name an existing model cache directory.")
    from mempalace.embedding import get_embedding_function

    if model == "minilm":
        base = get_embedding_function(device="cpu", model=model)

        class CacheOnlyMiniLM(type(base)):
            def _download_model_if_not_exists(self):
                if not all((cache / self.EXTRACTED_FOLDER_NAME / name).is_file() for name in MINILM_FILES):
                    raise RuntimeError("Cached local embedding files are missing; downloads are disabled.")

        embedder = CacheOnlyMiniLM(preferred_providers=["CPUExecutionProvider"], intra_op_num_threads=2)
        embedder.DOWNLOAD_PATH = cache
        embedder._download_model_if_not_exists()
        return embedder

    if model != "embeddinggemma":
        raise ValueError("Only cached minilm or embeddinggemma local models are supported.")
    from huggingface_hub import hf_hub_download

    for filename in ("onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data", "tokenizer.json"):
        hf_hub_download(GEMMA_REPO, filename=filename, cache_dir=str(cache), local_files_only=True)
    return get_embedding_function(device="cpu", model=model)


def migrate_lexical_projection(collection, palace: Path) -> int:
    """Add the CJK bigrams to documents stored before the projection existed; safe to rerun.

    Only the FTS source changes: embeddings, ids and metadata are kept as they are, so this
    runs on an existing palace without re-embedding anything.
    """
    marker = palace / PROJECTION_FILE
    if marker.is_file() and marker.read_text(encoding="utf-8") == PROJECTION_VERSION:
        return 0
    migrated = 0
    offset = 0
    while True:
        page = collection.get(limit=PROJECTION_PAGE, offset=offset, include=["documents"])
        if not page.ids:
            break
        projected = [lexical_text(document) for document in page.documents]
        changed = [position for position, document in enumerate(page.documents) if projected[position] != document]
        if changed:
            collection.update(
                ids=[page.ids[position] for position in changed],
                documents=[projected[position] for position in changed],
            )
            migrated += len(changed)
        offset += len(page.ids)
    marker.write_text(PROJECTION_VERSION, encoding="utf-8")
    return migrated


class LocalIndex:
    def __init__(self, backend, palace: Path, embedder):
        self.backend = backend
        self.collection = backend.get_collection(str(palace), COLLECTION, create=True)
        self.embedder = embedder
        # One local inference resource; backend writes use the backend's own SQLite locks.
        self.embedding_lock = threading.Lock()

    def vector(self, text: str) -> list[float]:
        with self.embedding_lock:
            output = self.embedder(input=[text])
        if len(output) != 1:
            raise RuntimeError("Embedding returned an unexpected row count.")
        vector = [float(value) for value in output[0]]
        if not vector or not all(math.isfinite(value) for value in vector) or not any(vector):
            raise RuntimeError("Embedding returned an invalid vector.")
        return vector

    @staticmethod
    def storage_id(namespace: str, index_id: str) -> str:
        encoded = json.dumps([namespace, index_id], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def health(self) -> dict:
        if not self.backend.health().ok:
            raise RuntimeError("Index backend is unavailable.")
        self.collection.count()
        return {"ok": True}

    def upsert(self, request: object) -> dict:
        data = fields(request, {"namespace", "indexId", "id", "revision", "content"})
        namespace = text_field(data, "namespace", 512)
        index_id = text_field(data, "indexId", 256)
        fact_id = text_field(data, "id", 256)
        revision = revision_field(data)
        content = text_field(data, "content", MAX_TEXT_BYTES)
        self.collection.upsert(
            ids=[self.storage_id(namespace, index_id)],
            # Native FTS5/BM25 needs text in this private index; authority stays in Postgres.
            documents=[lexical_text(content)],
            metadatas=[{"wing": namespace, "namespace": namespace, "id": fact_id, "revision": revision}],
            embeddings=[self.vector(content)],
        )
        return {"ok": True}

    def remove(self, request: object) -> dict:
        data = fields(request, {"namespace", "indexId"})
        namespace = text_field(data, "namespace", 512)
        index_id = text_field(data, "indexId", 256)
        self.collection.delete(ids=[self.storage_id(namespace, index_id)])
        return {"ok": True}

    def search(self, request: object) -> dict:
        data = fields(request, {"namespace", "query", "limit"})
        namespace = text_field(data, "namespace", 512)
        query = text_field(data, "query", MAX_TEXT_BYTES)
        limit = data.get("limit")
        if type(limit) is not int or not 1 <= limit <= MAX_CANDIDATES:
            raise InvalidRequest("Invalid limit.")
        result = self.collection.query(
            query_embeddings=[self.vector(query)], n_results=limit,
            where={"wing": namespace}, include=["metadatas", "distances"],
        )
        lexical = self.collection.lexical_search(
            query=lexical_text(query), n_results=limit, where={"wing": namespace},
        )
        vector_hits = []
        for metadata, distance in zip(result.metadatas[0], result.distances[0], strict=True):
            if not math.isfinite(distance):
                raise RuntimeError("Index returned an invalid score.")
            similarity = 1.0 - distance
            if similarity >= MIN_VECTOR_SIMILARITY:
                vector_hits.append((metadata, similarity))
        lexical_hits = []
        for hit in lexical.hits:
            if not math.isfinite(hit.score):
                raise RuntimeError("Index returned an invalid score.")
            lexical_hits.append((hit.metadata, hit.score))
        candidates = {}
        # Equal-weight reciprocal ranks avoid mixing cosine and BM25 score scales.
        # Lexical-first stable ties retain exact path/id hits outside the vector top-k.
        for rows in (lexical_hits, vector_hits):
            for rank, (metadata, backend_score) in enumerate(rows, start=1):
                if metadata.get("namespace") != namespace:
                    continue
                fact_id = text_field(metadata, "id", 256)
                revision = revision_field(metadata)
                candidate = candidates.setdefault(
                    (fact_id, revision), {"id": fact_id, "revision": revision, "score": 0.0},
                )
                candidate["score"] += (RRF_OFFSET + 1) / (2 * (RRF_OFFSET + rank))
        ranked = sorted(candidates.values(), key=lambda candidate: candidate["score"], reverse=True)
        return {"candidates": ranked[:limit]}


class IndexHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, index: LocalIndex, token: str):
        if not ipaddress.ip_address(address[0]).is_loopback or not TOKEN_RE.fullmatch(token):
            raise ValueError("Index server requires loopback bind and a bearer token.")
        self.index = index
        self.token = token
        super().__init__(address, IndexRequestHandler)


class IPv6IndexHTTPServer(IndexHTTPServer):
    address_family = socket.AF_INET6


class IndexRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LocalMemoryIndex/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, _format, *args):
        # No URL, headers, token, indexed text or exception messages in access logs.
        pass

    def reply(self, status: int, body: dict):
        encoded = json.dumps(body, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def authorized(self) -> bool:
        auth = self.headers.get_all("Authorization", [])
        if (
            not ipaddress.ip_address(self.client_address[0]).is_loopback or
            len(auth) != 1 or not hmac.compare_digest(auth[0], f"Bearer {self.server.token}")
        ):
            self.reply(401, {"error": "Unauthorized."})
            return False
        return True

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method: str):
        try:
            if not self.authorized():
                return
            if method == "GET" and self.path == "/health":
                self.reply(200, self.server.index.health())
                return
            operations = {"/search": self.server.index.search, "/upsert": self.server.index.upsert, "/delete": self.server.index.remove}
            operation = operations.get(self.path) if method == "POST" else None
            if operation is None:
                self.reply(404, {"error": "Unknown endpoint."})
                return
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
                self.reply(400, {"error": "A single Content-Length is required."})
                return
            length = int(lengths[0])
            if length > MAX_BODY_BYTES:
                self.reply(413, {"error": "Request is too large."})
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                self.reply(415, {"error": "JSON content is required."})
                return
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise InvalidRequest("Incomplete request body.")
            try:
                data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeError) as exc:
                raise InvalidRequest("Invalid JSON request.") from exc
            result = operation(data)
        except InvalidRequest as exc:
            self.reply(400, {"error": str(exc)})
            return
        except TimeoutError:
            self.reply(408, {"error": "Request timed out."})
            return
        except (BrokenPipeError, ConnectionResetError):
            # The deadline-owning client has already released this response.
            self.close_connection = True
            return
        except Exception as exc:
            print(f"Local memory index operation failed ({type(exc).__name__}).", file=sys.stderr)
            self.reply(500, {"error": "Index operation failed."})
            return
        self.reply(200, result)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--palace-dir", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--embedding-model", choices=("minilm", "embeddinggemma"), required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args(argv)
    host = ipaddress.ip_address(args.host)
    if not host.is_loopback:
        parser.error("host must be a loopback IP literal.")
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535.")
    token = read_token(args.token_file)
    palace = prepare_palace_dir(args.palace_dir, args.embedding_model)
    cache = args.cache_dir.expanduser().resolve()
    configure_offline(palace, cache)
    embedder = load_cached_embedder(args.embedding_model, cache)
    from mempalace.backends.sqlite_exact import SQLiteExactBackend

    backend = SQLiteExactBackend()
    try:
        index = LocalIndex(backend, palace, embedder)
        migrated = migrate_lexical_projection(index.collection, palace)
        if migrated:
            print(f"Migrated the lexical projection for {migrated} indexed documents.", flush=True)
        server_type = IPv6IndexHTTPServer if host.version == 6 else IndexHTTPServer
        with server_type((str(host), args.port), index, token) as server:
            print(f"Local memory index listening on loopback port {args.port}.", flush=True)
            server.serve_forever()
    finally:
        backend.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        pass
