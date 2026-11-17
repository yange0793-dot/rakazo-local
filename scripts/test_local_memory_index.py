"""Offline wire tests; optional installed-backend smoke uses synthetic embeddings only."""

from __future__ import annotations

import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace
import tempfile
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("local_memory_index", Path(__file__).with_name("local-memory-index.py"))
index_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(index_module)
TOKEN = "synthetic-local-index-test-token-00000001"
EXACT_PATH = "/fixture/projects/widget-k92/record-az19.py"
EXACT_ID = "RID-7F2C9D"
LEXICAL_CONTENT = f"Location {EXACT_PATH}. Tracking {EXACT_ID}."


class SyntheticEmbedder:
    def __init__(self):
        self.calls = []

    def __call__(self, input):
        self.calls.extend(input)
        # Test-only known vectors; this does not judge natural-language meaning.
        vectors = {
            "synthetic-a": [1.0, 0.0], "synthetic-b": [0.0, 1.0], "synthetic-query": [1.0, 0.0],
            LEXICAL_CONTENT: [-1.0, 0.0], EXACT_PATH: [1.0, 0.0], EXACT_ID: [1.0, 0.0],
        }
        return [vectors[text] for text in input]


class FakeCollection:
    def __init__(self):
        self.rows = {}
        self.last_query = None
        self.last_lexical_query = None

    def upsert(self, *, ids, documents, metadatas, embeddings):
        for storage_id, document, metadata, embedding in zip(ids, documents, metadatas, embeddings, strict=True):
            self.rows[storage_id] = {"document": document, "metadata": metadata, "embedding": embedding}

    def delete(self, *, ids):
        for storage_id in ids:
            self.rows.pop(storage_id, None)

    def query(self, *, query_embeddings, n_results, where, include):
        self.last_query = {"where": where, "include": include}
        # Synthetic vectors are unit length, so their dot product is cosine similarity.
        ranked = sorted(
            [(1.0 - sum(a * b for a, b in zip(row["embedding"], query_embeddings[0], strict=True)), row)
             for row in self.rows.values() if row["metadata"]["wing"] == where["wing"]],
            key=lambda pair: pair[0],
        )[:n_results]
        return SimpleNamespace(
            metadatas=[[row["metadata"] for _, row in ranked]],
            distances=[[distance for distance, _ in ranked]],
        )

    def lexical_search(self, *, query, n_results, where):
        self.last_lexical_query = {"query": query, "n_results": n_results, "where": where}
        query_tokens = set(re.findall(r"\w{2,}", query.lower()))
        hits = []
        for storage_id, row in self.rows.items():
            if row["metadata"]["wing"] != where["wing"]:
                continue
            # Contract fake only: shared token count, not a reimplementation of BM25.
            score = len(query_tokens & set(re.findall(r"\w{2,}", row["document"].lower())))
            if score:
                hits.append(SimpleNamespace(id=storage_id, document=row["document"], metadata=row["metadata"], score=float(score)))
        hits.sort(key=lambda hit: hit.score, reverse=True)
        return SimpleNamespace(hits=hits[:n_results])

    def count(self):
        return len(self.rows)


class FakeBackend:
    def __init__(self):
        self.collection = FakeCollection()

    def get_collection(self, path, name, create):
        return self.collection

    def health(self):
        return SimpleNamespace(ok=True)


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.embedder = SyntheticEmbedder()
        self.index = index_module.LocalIndex(self.backend, Path("/synthetic-index"), self.embedder)

    def input(self, **updates):
        return {"namespace": "space-a:bot-a", "indexId": "fact-a:1", "id": "fact-a", "revision": 1, "content": "synthetic-a", **updates}

    def test_exact_upsert_and_delete_are_idempotent(self):
        request = self.input()
        self.index.upsert(request)
        self.index.upsert(request)
        self.assertEqual(self.backend.collection.count(), 1)
        self.assertEqual(next(iter(self.backend.collection.rows.values()))["document"], request["content"])
        self.index.remove({"namespace": request["namespace"], "indexId": request["indexId"]})
        self.index.remove({"namespace": request["namespace"], "indexId": request["indexId"]})
        self.assertEqual(self.backend.collection.count(), 0)

    def test_namespace_and_revision_ids_do_not_collide(self):
        self.index.upsert(self.input())
        self.index.upsert(self.input(namespace="space-b:bot-b", content="synthetic-b"))
        self.index.upsert(self.input(indexId="fact-a:2", revision=2, content="synthetic-b"))
        self.assertEqual(self.backend.collection.count(), 3)
        result = self.index.search({"namespace": "space-a:bot-a", "query": "synthetic-query", "limit": 5})
        self.assertEqual(result, {"candidates": [
            {"id": "fact-a", "revision": 1, "score": 1.0},
            {"id": "fact-a", "revision": 2, "score": 61 / 62},
        ]})
        self.assertEqual(self.backend.collection.last_query, {"where": {"wing": "space-a:bot-a"}, "include": ["metadatas", "distances"]})
        self.assertEqual(self.backend.collection.last_lexical_query, {
            "query": "synthetic-query", "n_results": 5, "where": {"wing": "space-a:bot-a"},
        })
        self.index.remove({"namespace": "space-a:bot-a", "indexId": "fact-a:1"})
        self.assertEqual(self.backend.collection.count(), 2)

    def test_exact_path_and_identifier_recall_beyond_vector_top_k(self):
        self.index.upsert(self.input())
        self.index.upsert(self.input(indexId="fact-b:1", id="fact-b", content="synthetic-b"))
        self.index.upsert(self.input(indexId="exact:3", id="exact", revision=3, content=LEXICAL_CONTENT))
        self.index.upsert(self.input(namespace="space-b:bot-b", indexId="foreign:1", id="foreign", content=LEXICAL_CONTENT))
        for query in (EXACT_PATH, EXACT_ID):
            with self.subTest(query=query):
                vector_only = self.backend.collection.query(
                    query_embeddings=[[1.0, 0.0]], n_results=1,
                    where={"wing": "space-a:bot-a"}, include=["metadatas", "distances"],
                )
                self.assertEqual(vector_only.metadatas[0][0]["id"], "fact-a")
                self.assertEqual(self.index.search({"namespace": "space-a:bot-a", "query": query, "limit": 1}), {
                    "candidates": [{"id": "exact", "revision": 3, "score": 0.5}],
                })
                self.assertEqual(self.index.search({"namespace": "space-a:bot-a", "query": query, "limit": 2}), {
                    "candidates": [
                        {"id": "exact", "revision": 3, "score": 0.5},
                        {"id": "fact-a", "revision": 1, "score": 0.5},
                    ],
                })
                self.assertEqual(self.backend.collection.last_lexical_query["where"], {"wing": "space-a:bot-a"})
        self.index.remove({"namespace": "space-a:bot-a", "indexId": "exact:3"})
        result = self.index.search({"namespace": "space-a:bot-a", "query": EXACT_ID, "limit": 2})
        self.assertEqual([candidate["id"] for candidate in result["candidates"]], ["fact-a", "fact-b"])

    def test_boundaries_reject_before_embedding(self):
        for request in (
            self.input(revision=True), self.input(revision=0), self.input(revision=2**53),
            self.input(content="x" * (index_module.MAX_TEXT_BYTES + 1)),
            self.input(namespace=""), self.input(content="bad\0content"),
            self.input(content="\ud800"), self.input(extra="not-supported"),
        ):
            with self.subTest(request_fields=list(request)):
                with self.assertRaises(index_module.InvalidRequest):
                    self.index.upsert(request)
        self.assertEqual(self.embedder.calls, [])
        with self.assertRaises(index_module.InvalidRequest):
            self.index.search({"namespace": "space-a", "query": "synthetic-query", "limit": 51})

    def test_degenerate_vectors_fail_visibly(self):
        for value in ([0.0, 0.0], [float("nan"), 1.0], []):
            index = index_module.LocalIndex(FakeBackend(), Path("/synthetic-index"), lambda input: [value])
            with self.assertRaises(RuntimeError):
                index.upsert(self.input())


class DirectoryAndTokenTests(unittest.TestCase):
    def test_new_directory_and_owned_restart_only(self):
        with tempfile.TemporaryDirectory() as root:
            palace = Path(root) / "new-index"
            index_module.prepare_palace_dir(palace, "minilm")
            index_module.prepare_palace_dir(palace, "minilm")
            with self.assertRaises(ValueError):
                index_module.prepare_palace_dir(palace, "embeddinggemma")
            arbitrary = Path(root) / "existing"
            arbitrary.mkdir()
            (arbitrary / "sqlite_exact.sqlite3").write_bytes(b"synthetic existing file")
            with self.assertRaises(ValueError):
                index_module.prepare_palace_dir(arbitrary, "minilm")

    def test_server_refuses_non_loopback_and_missing_token(self):
        for address, token in (("0.0.0.0", TOKEN), ("10.0.0.8", TOKEN), ("127.0.0.1", "")):
            with self.subTest(address=address):
                with self.assertRaises(ValueError):
                    index_module.IndexHTTPServer((address, 0), None, token)

    def test_rejects_old_or_default_palace_paths_without_opening(self):
        for target in (Path("/synthetic/claudebot/palace"), Path("/synthetic/.mempalace"), Path.home(), Path("relative")):
            with self.subTest(target=str(target)):
                with self.assertRaises(ValueError):
                    index_module.validate_palace_path(target)

    def test_token_file_is_mandatory_private_and_not_a_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            token = Path(root) / "token"
            token.write_text(TOKEN, encoding="utf-8")
            token.chmod(0o600)
            self.assertEqual(index_module.read_token(token), TOKEN)
            token.chmod(0o644)
            with self.assertRaises(ValueError):
                index_module.read_token(token)
            token.chmod(0o600)
            link = Path(root) / "linked-token"
            link.symlink_to(token)
            with self.assertRaises(ValueError):
                index_module.read_token(link)

    def test_missing_cached_models_never_call_download(self):
        with tempfile.TemporaryDirectory() as root:
            cache = Path(root)
            fake_base = type("SyntheticMiniLM", (), {
                "EXTRACTED_FOLDER_NAME": "onnx", "__init__": lambda self, **kwargs: None,
            })()
            fake_module = SimpleNamespace(get_embedding_function=lambda **kwargs: fake_base)
            with patch.dict("sys.modules", {"mempalace.embedding": fake_module}), patch.dict(os.environ):
                with self.assertRaisesRegex(RuntimeError, "downloads are disabled"):
                    index_module.load_cached_embedder("minilm", cache)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.index = index_module.LocalIndex(FakeBackend(), Path("/synthetic-index"), SyntheticEmbedder())
        self.server = index_module.IndexHTTPServer(("127.0.0.1", 0), self.index, TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, data=None, **header_updates):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        body = None if data is None else json.dumps(data).encode("utf-8")
        headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", **header_updates}
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_authentication_precedes_index_access(self):
        self.assertEqual(self.request("GET", "/health", Authorization="Bearer wrong")[0], 401)
        self.assertEqual(self.request("POST", "/upsert", {}, Authorization="Bearer wrong")[0], 401)
        self.assertEqual(self.request("GET", "/health"), (200, {"ok": True}))

    def test_routes_are_exact_and_requests_bounded(self):
        self.assertEqual(self.request("GET", "/health?redirect=elsewhere")[0], 404)
        self.assertEqual(self.request("POST", "/unknown", {})[0], 404)
        self.assertEqual(self.request("POST", "/search", {}, **{"Content-Length": str(index_module.MAX_BODY_BYTES + 1)})[0], 413)
        self.assertEqual(self.request("POST", "/search", {}, **{"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/search", {})[0], 400)

    def test_http_wire_round_trip_contains_candidates_only(self):
        request = {"namespace": "space-a", "indexId": "fact-a:1", "id": "fact-a", "revision": 1, "content": "synthetic-a"}
        self.assertEqual(self.request("POST", "/upsert", request), (200, {"ok": True}))
        status, result = self.request("POST", "/search", {"namespace": "space-a", "query": "synthetic-query", "limit": 1})
        self.assertEqual(status, 200)
        self.assertEqual(result, {"candidates": [{"id": "fact-a", "revision": 1, "score": 1.0}]})
        self.assertEqual(self.request("POST", "/delete", {"namespace": "space-a", "indexId": "fact-a:1"}), (200, {"ok": True}))


@unittest.skipUnless(os.environ.get("LOCAL_MEMORY_TEST_INSTALLED_BACKEND") == "1", "opt-in installed-backend smoke")
class InstalledBackendSmoke(unittest.TestCase):
    def test_installed_exact_backend_with_new_temp_palace_and_synthetic_vectors(self):
        with tempfile.TemporaryDirectory(prefix="rakazo-memory-index-test-") as root:
            palace = index_module.prepare_palace_dir(Path(root) / "palace", "synthetic-test")
            self.enterContext(patch.dict(os.environ, {
                "MEMPALACE_CONFIG_DIR": str(palace / "config"),
                "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "ANONYMIZED_TELEMETRY": "False",
            }))
            from mempalace.backends.sqlite_exact import SQLiteExactBackend

            backend = SQLiteExactBackend()
            try:
                index = index_module.LocalIndex(backend, palace, SyntheticEmbedder())
                index.upsert({"namespace": "space-a", "indexId": "fact-a:1", "id": "fact-a", "revision": 1, "content": "synthetic-a"})
                index.upsert({"namespace": "space-a", "indexId": "fact-a:1", "id": "fact-a", "revision": 1, "content": "synthetic-a"})
                index.upsert({"namespace": "space-b", "indexId": "fact-b:1", "id": "fact-b", "revision": 1, "content": "synthetic-b"})
                self.assertEqual(index.collection.count(), 2)
                result = index.search({"namespace": "space-a", "query": "synthetic-query", "limit": 5})
                self.assertEqual(result, {"candidates": [{"id": "fact-a", "revision": 1, "score": 1.0}]})
                rows = index.collection.get(include=["documents"])
                self.assertCountEqual(rows.documents, ["synthetic-a", "synthetic-b"])
                index.remove({"namespace": "space-a", "indexId": "fact-a:1"})
                index.remove({"namespace": "space-a", "indexId": "fact-a:1"})
                self.assertEqual(index.search({"namespace": "space-a", "query": "synthetic-query", "limit": 5}), {"candidates": []})
                self.assertEqual(index.collection.count(), 1)
            finally:
                backend.close()

    def test_native_fts_path_and_identifier_hits_outside_fixed_vector_top_k(self):
        with tempfile.TemporaryDirectory(prefix="rakazo-memory-hybrid-test-") as root:
            palace = index_module.prepare_palace_dir(Path(root) / "palace", "synthetic-test")
            self.enterContext(patch.dict(os.environ, {
                "MEMPALACE_CONFIG_DIR": str(palace / "config"),
                "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "ANONYMIZED_TELEMETRY": "False",
            }))
            from mempalace.backends.sqlite_exact import SQLiteExactBackend

            backend = SQLiteExactBackend()
            try:
                index = index_module.LocalIndex(backend, palace, SyntheticEmbedder())
                for index_id, fact_id, content, namespace in (
                    ("fact-a:1", "fact-a", "synthetic-a", "space-a"),
                    ("fact-b:1", "fact-b", "synthetic-b", "space-a"),
                    ("exact:1", "exact", LEXICAL_CONTENT, "space-a"),
                    ("foreign:1", "foreign", LEXICAL_CONTENT, "space-b"),
                ):
                    index.upsert({"namespace": namespace, "indexId": index_id, "id": fact_id, "revision": 1, "content": content})
                # Require the real FTS5 branch, rather than testing only the native fallback.
                with index.collection._cursor() as cursor:
                    self.assertTrue(index.collection._fts_available(cursor))
                for query in (EXACT_PATH, EXACT_ID):
                    with self.subTest(query=query):
                        nearest = index.collection.query(
                            query_embeddings=[[1.0, 0.0]], n_results=1,
                            where={"wing": "space-a"}, include=["metadatas", "distances"],
                        )
                        self.assertEqual(nearest.metadatas[0][0]["id"], "fact-a")
                        native = index.collection.lexical_search(query=query, n_results=1, where={"wing": "space-a"})
                        self.assertEqual([hit.metadata["id"] for hit in native.hits], ["exact"])
                        self.assertEqual(native.hits[0].document, LEXICAL_CONTENT)
                        self.assertGreater(native.hits[0].score, 0)
                        self.assertEqual(index.search({"namespace": "space-a", "query": query, "limit": 1}), {
                            "candidates": [{"id": "exact", "revision": 1, "score": 0.5}],
                        })
                        self.assertEqual(index.search({"namespace": "space-a", "query": query, "limit": 2}), {
                            "candidates": [
                                {"id": "exact", "revision": 1, "score": 0.5},
                                {"id": "fact-a", "revision": 1, "score": 0.5},
                            ],
                        })
                index.remove({"namespace": "space-a", "indexId": "exact:1"})
                self.assertEqual(index.collection.lexical_search(query=EXACT_ID, n_results=5, where={"wing": "space-a"}).hits, [])
                self.assertEqual([hit.metadata["id"] for hit in index.collection.lexical_search(
                    query=EXACT_ID, n_results=5, where={"wing": "space-b"},
                ).hits], ["foreign"])
            finally:
                backend.close()


if __name__ == "__main__":
    unittest.main()
