"""Offline tests for the LangMem extraction child. No model or network calls are made."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import threading
import unittest

SCRIPT = Path(__file__).with_name("langmem-memory-extractor.py")


class Child:
    def __init__(self, respond):
        self.respond = respond
        self.proc = subprocess.Popen(
            [sys.executable, "-I", str(SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.requests = []
        self.timer = threading.Timer(60, self.proc.kill)
        self.timer.start()

    def run(self, request, allow_removals=False):
        assert self.proc.stdin is not None
        frame = {"type": "extract", "request": request}
        if allow_removals:
            frame["allowRemovals"] = True
        self.proc.stdin.write(json.dumps(frame, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        try:
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    return None
                event = json.loads(line)
                if event.get("type") == "completion":
                    self.requests.append(event["request"])
                    reply = self.respond(event, len(self.requests))
                    self.proc.stdin.write(
                        json.dumps(
                            {"type": "completion_result", "id": event["id"], **reply},
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    self.proc.stdin.flush()
                    continue
                return event
        finally:
            self.timer.cancel()
            self.proc.stdin.close()
            self.proc.wait(timeout=20)
            assert self.proc.stderr is not None
            self._stderr = self.proc.stderr.read()
            self.proc.stderr.close()
            if self.proc.stdout is not None:
                self.proc.stdout.close()

    def stderr(self):
        return self._stderr


def request(messages, existing=None, notes=None):
    return {
        "messages": messages,
        "existing": existing or [],
        "notes": notes or [],
    }


def message(message_id, content, is_new=True, role="user"):
    return {
        "id": message_id,
        "role": role,
        "content": content,
        "createdAt": "2026-11-17T00:00:00.000Z",
        "isNew": is_new,
    }


def tool_reply(*calls):
    return {"content": "", "toolCalls": list(calls)}


def nothing_reply():
    return tool_reply({"id": "call-none", "name": "NoDurableFact", "args": {}})


def active_preference():
    return {
        "id": "f1",
        "revision": 3,
        "content": "用户喜欢浅色模式",
        "status": "active",
        "sourceMessageId": "m1",
        "sourceQuote": "喜欢浅色模式",
        "category": "preference",
    }


class LangMemExtractorTest(unittest.TestCase):
    def test_inserts_chinese_memory_from_new_user_quote(self):
        child = Child(
            lambda event, round_number: tool_reply(
                {
                    "id": "call-1",
                    "name": "DurableFact",
                    "args": {
                        "content": "用户偏好深色模式",
                        "sourceMessageId": "m1",
                        "sourceQuote": "以后都用深色模式",
                        "category": "preference",
                    },
                }
            )
        )
        event = child.run(request([message("m1", "以后都用深色模式，别再问我了。")]))
        self.assertEqual(event["type"], "result")
        self.assertEqual(
            event["changes"],
            [
                {
                    "content": "用户偏好深色模式",
                    "sourceMessageId": "m1",
                    "sourceQuote": "以后都用深色模式",
                    "category": "preference",
                }
            ],
        )
        prompt = "\n".join(
            str(item.get("content", "")) for item in child.requests[0]["messages"]
        )
        self.assertIn("以后都用深色模式", prompt)

    def test_correction_patches_existing_and_keeps_expected_revision(self):
        child = Child(
            lambda event, round_number: tool_reply(
                {
                    "id": "call-1",
                    "name": "PatchDoc",
                    "args": {
                        "json_doc_id": "f1",
                        "planned_edits": "Replace the outdated preference.",
                        "patches": [
                            {"op": "replace", "path": "/content", "value": "用户偏好深色模式"},
                            {"op": "replace", "path": "/sourceMessageId", "value": "m2"},
                            {
                                "op": "replace",
                                "path": "/sourceQuote",
                                "value": "现在更喜欢深色模式",
                            },
                        ],
                    },
                }
            )
        )
        event = child.run(
            request(
                [
                    message("m1", "喜欢浅色模式", is_new=False),
                    message("m2", "其实我现在更喜欢深色模式"),
                ],
                existing=[
                    {
                        "id": "f1",
                        "revision": 3,
                        "content": "用户喜欢浅色模式",
                        "status": "active",
                        "sourceMessageId": "m1",
                        "sourceQuote": "喜欢浅色模式",
                        "category": "preference",
                    }
                ],
            )
        )
        self.assertEqual(event["type"], "result")
        self.assertEqual(len(event["changes"]), 1)
        change = event["changes"][0]
        self.assertEqual(change["replacesId"], "f1")
        self.assertEqual(change["expectedRevision"], 3)
        self.assertEqual(change["content"], "用户偏好深色模式")
        self.assertEqual(change["sourceMessageId"], "m2")

    def test_multiple_tool_calls_keep_their_ids_in_one_turn(self):
        child = Child(
            lambda event, round_number: tool_reply(
                {
                    "id": "call-update",
                    "name": "PatchDoc",
                    "args": {
                        "json_doc_id": "f1",
                        "planned_edits": "Update the preference.",
                        "patches": [
                            {"op": "replace", "path": "/content", "value": "用户偏好深色模式"},
                            {"op": "replace", "path": "/sourceMessageId", "value": "m2"},
                            {
                                "op": "replace",
                                "path": "/sourceQuote",
                                "value": "现在更喜欢深色模式",
                            },
                        ],
                    },
                },
                {
                    "id": "call-insert",
                    "name": "DurableFact",
                    "args": {
                        "content": "项目代号是北辰",
                        "sourceMessageId": "m2",
                        "sourceQuote": "项目代号叫北辰",
                        "category": "project",
                    },
                },
            )
        )
        event = child.run(
            request(
                [message("m2", "现在更喜欢深色模式。项目代号叫北辰。")],
                existing=[
                    {
                        "id": "f1",
                        "revision": 3,
                        "content": "用户喜欢浅色模式",
                        "status": "active",
                        "sourceMessageId": "m1",
                        "sourceQuote": "喜欢浅色模式",
                        "category": "preference",
                    }
                ],
            )
        )
        self.assertEqual(event["type"], "result")
        self.assertEqual(len(event["changes"]), 2)
        self.assertEqual(event["changes"][0]["replacesId"], "f1")
        self.assertEqual(event["changes"][1]["content"], "项目代号是北辰")
        self.assertNotIn("replacesId", event["changes"][1])

    def test_unchanged_existing_is_not_written(self):
        child = Child(lambda event, round_number: nothing_reply())
        event = child.run(
            request(
                [message("m2", "今天天气不错")],
                existing=[
                    {
                        "id": "f1",
                        "revision": 4,
                        "content": "用户偏好深色模式",
                        "status": "active",
                        "sourceMessageId": "m1",
                        "sourceQuote": "以后都用深色模式",
                        "category": "preference",
                    }
                ],
            )
        )
        self.assertEqual(event, {"type": "result", "changes": [], "dropped": 0})

    def test_nothing_to_remember_is_an_explicit_tool_call(self):
        child = Child(lambda event, round_number: nothing_reply())
        event = child.run(request([message("m1", "谢谢")]))
        self.assertEqual(event["type"], "result")
        self.assertEqual(event["changes"], [])

    def test_text_only_reply_is_a_protocol_failure(self):
        child = Child(
            lambda event, round_number: {
                "content": "这段对话里没有需要长期记住的信息。",
                "toolCalls": [],
            }
        )
        event = child.run(
            request(
                [message("m2", "谢谢")],
                existing=[
                    {
                        "id": "f1",
                        "revision": 4,
                        "content": "用户偏好深色模式",
                        "status": "active",
                        "sourceMessageId": "m1",
                        "sourceQuote": "以后都用深色模式",
                        "category": "preference",
                    }
                ],
            )
        )
        self.assertEqual(event["type"], "error")
        self.assertEqual(child.proc.returncode, 1)
        self.assertIn("TransportFailure", child.stderr())

    def test_forgotten_evidence_is_context_only_and_kept_out_of_existing(self):
        child = Child(lambda event, round_number: nothing_reply())
        event = child.run(
            request(
                [message("m1", "今天天气不错")],
                existing=[
                    {
                        "id": "f2",
                        "revision": 7,
                        "content": "已被遗忘的旧地址",
                        "status": "forgotten",
                    }
                ],
            )
        )
        self.assertEqual(event, {"type": "result", "changes": [], "dropped": 0})
        prompt = "\n".join(
            str(item.get("content", "")) for item in child.requests[0]["messages"]
        )
        self.assertIn("已被遗忘的旧地址", prompt)
        self.assertIn("retirementEvidence", prompt)
        self.assertNotIn('"status": "active"', prompt)

    def test_unverifiable_quote_is_dropped_on_its_own(self):
        quote = "这句话不在新消息里"
        child = Child(
            lambda event, round_number: tool_reply(
                {
                    "id": "call-good",
                    "name": "DurableFact",
                    "args": {
                        "content": "用户偏好深色模式",
                        "sourceMessageId": "m1",
                        "sourceQuote": "以后都用深色模式",
                        "category": "preference",
                    },
                },
                {
                    "id": "call-bad",
                    "name": "DurableFact",
                    "args": {
                        "content": "用户提到了别的偏好",
                        "sourceMessageId": "m1",
                        "sourceQuote": quote,
                        "category": "preference",
                    },
                },
            )
        )
        event = child.run(request([message("m1", "以后都用深色模式")]))
        self.assertEqual(event["type"], "result")
        self.assertEqual(
            [change["content"] for change in event["changes"]], ["用户偏好深色模式"]
        )
        self.assertEqual(event["dropped"], 1)
        self.assertNotIn(quote, child.stderr())

    def test_removal_is_offered_only_when_the_parent_asks(self):
        child = Child(
            lambda event, round_number: tool_reply(
                {
                    "id": "call-remove",
                    "name": "ForgetFact",
                    "args": {
                        "targetId": "f1",
                        "sourceMessageId": "m2",
                        "sourceQuote": "别再记我的地址了",
                    },
                }
            )
        )
        event = child.run(
            request([message("m2", "别再记我的地址了")], existing=[active_preference()])
        )
        # The host did not enable removals, so the tool is not offered and nothing is removed.
        tool_names = [tool["name"] for tool in child.requests[0]["tools"]]
        self.assertIn("DurableFact", tool_names)
        self.assertNotIn("ForgetFact", tool_names)
        prompt = "\n".join(
            str(item.get("content", "")) for item in child.requests[0]["messages"]
        )
        self.assertIn("You cannot delete a memory from here", prompt)
        self.assertEqual(event, {"type": "result", "changes": [], "dropped": 0})

    def test_removal_cites_the_users_own_words_and_the_known_revision(self):
        child = Child(
            lambda event, round_number: tool_reply(
                {
                    "id": "call-remove",
                    "name": "ForgetFact",
                    "args": {
                        "targetId": "f1",
                        "sourceMessageId": "m2",
                        "sourceQuote": "别再记我的地址了",
                    },
                }
            )
        )
        event = child.run(
            request(
                [message("m2", "别再记我的地址了，我早就不住北京了。")],
                existing=[active_preference()],
            ),
            allow_removals=True,
        )
        self.assertEqual(event["type"], "result")
        self.assertEqual(
            event["changes"],
            [
                {
                    "content": "用户喜欢浅色模式",
                    "sourceMessageId": "m2",
                    "sourceQuote": "别再记我的地址了",
                    "category": "preference",
                    "replacesId": "f1",
                    "expectedRevision": 3,
                    "remove": True,
                }
            ],
        )
        self.assertEqual(event["dropped"], 0)
        tool_names = [tool["name"] for tool in child.requests[0]["tools"]]
        self.assertIn("ForgetFact", tool_names)
        prompt = "\n".join(
            str(item.get("content", "")) for item in child.requests[0]["messages"]
        )
        self.assertIn("call ForgetFact once", prompt)
        self.assertNotIn("You cannot delete a memory from here", prompt)

    def test_removal_without_matching_evidence_is_dropped_on_its_own(self):
        child = Child(
            lambda event, round_number: tool_reply(
                {
                    "id": "call-quote",
                    "name": "ForgetFact",
                    "args": {
                        "targetId": "f1",
                        "sourceMessageId": "m2",
                        "sourceQuote": "这句话不在新消息里",
                    },
                },
                {
                    "id": "call-target",
                    "name": "ForgetFact",
                    "args": {
                        "targetId": "f-missing",
                        "sourceMessageId": "m2",
                        "sourceQuote": "别再记我的地址了",
                    },
                },
            )
        )
        event = child.run(
            request(
                [message("m2", "别再记我的地址了")],
                existing=[active_preference()],
            ),
            allow_removals=True,
        )
        self.assertEqual(event, {"type": "result", "changes": [], "dropped": 2})

    def test_removal_is_not_offered_without_an_active_fact(self):
        child = Child(lambda event, round_number: nothing_reply())
        event = child.run(
            request([message("m2", "别再记我的地址了")]),
            allow_removals=True,
        )
        self.assertEqual(event["type"], "result")
        self.assertEqual(event["changes"], [])
        tool_names = [tool["name"] for tool in child.requests[0]["tools"]]
        self.assertNotIn("ForgetFact", tool_names)


if __name__ == "__main__":
    unittest.main()
