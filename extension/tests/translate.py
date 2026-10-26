"""Hover translation in the connector, against the fixture app-server: no account or model."""

import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "native"))
import translate

fixture = root / "tests/fixtures/app-server-replay.py"


class Inbox:
    def __init__(self):
        self.messages = []
        self.lock = threading.Lock()

    def __call__(self, message):
        with self.lock:
            self.messages.append(message)

    def of(self, ident):
        with self.lock:
            return [m for m in self.messages if m.get("id") == ident]

    def final(self, ident, seconds=20):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            for m in self.of(ident):
                if m.get("done") or m.get("error"):
                    return m
            time.sleep(0.02)
        raise AssertionError(f"No answer for {ident}: {self.messages}")


def launcher(folder, server=fixture, code=None):
    """A codex stand-in that records its arguments, then runs the fixture."""
    script = Path(folder) / "codex"
    if code:
        server = Path(folder) / "server.py"
        server.write_text(code)
    target = f"'{server}'"
    script.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$@\" > '{folder}/argv'\n"
        f"exec '{sys.executable}' {target} \"$@\"\n"
    )
    script.chmod(0o700)
    return str(script)


def log(home):
    path = Path(home) / "fixture-translations.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


with tempfile.TemporaryDirectory() as home:
    os.environ["CODEX_HOME"] = home
    inbox = Inbox()
    translator = translate.Translator(home, lambda: launcher(home), inbox)
    try:
        translator.warm()
        until = time.monotonic() + 20
        while not translator.thread_id and time.monotonic() < until:
            time.sleep(0.02)
        assert translator.thread_id, "Warming starts the app-server and a thread"
        argv = Path(home, "argv").read_text().splitlines()
        assert argv[:2] == ["app-server", "--stdio"], argv
        for setting in [
            "notify=[]",
            "mcp_servers={}",
            "features.hooks=false",
            "features.memories=false",
        ]:
            assert setting in argv, (setting, argv)
        started = [e for e in log(home) if e["method"] == "thread/start"]
        assert len(started) == 1
        params = started[0]["params"]
        assert params["ephemeral"] is True
        assert params["model"] == "gpt-6-luna"
        assert params["dynamicTools"] == [] and params["environments"] == []
        assert "Simplified Chinese" in params["baseInstructions"]
        assert params["cwd"] == str(Path(home) / "projects/tabgent/translate")
        # The warm-up turn runs before any hover, so the first translation is not the slow one.
        until = time.monotonic() + 20
        while (
            not [e for e in log(home) if e["method"] == "turn/start"]
            and time.monotonic() < until
        ):
            time.sleep(0.02)
        warm = [e for e in log(home) if e["method"] == "turn/start"]
        assert warm and warm[0]["params"]["input"] == [
            {"type": "text", "text": "Hello."}
        ]
        print(
            "PASS warming starts a lean app-server with an ephemeral gpt-6-luna thread"
        )

        translator.translate("a", "Reading is a loop, not a line.")
        answer = inbox.final("a")
        assert answer == {
            "op": "translate",
            "id": "a",
            "done": True,
            "text": "译文：Reading is a loop, not a line.",
        }, answer
        deltas = [m["delta"] for m in inbox.of("a") if "delta" in m]
        assert len(deltas) == 3 and "".join(deltas) == answer["text"], deltas
        turn = [e for e in log(home) if e["method"] == "turn/start"][-1]["params"]
        assert turn["model"] == "gpt-6-luna" and turn["effort"] == "low", turn
        assert turn["input"] == [
            {"type": "text", "text": "Reading is a loop, not a line."}
        ]
        assert not any(m.get("delta") for m in inbox.messages if m.get("id") == "warm")
        print("PASS a translation streams its deltas, then the whole text")

        translator.translate("b", "A second sentence.")
        assert inbox.final("b")["text"] == "译文：A second sentence."
        threads = {
            e["params"]["threadId"] for e in log(home) if e["method"] == "turn/start"
        }
        assert len(threads) == 1, "Translations reuse the warm thread"
        assert len([e for e in log(home) if e["method"] == "thread/start"]) == 1
        print("PASS later translations reuse the warm ephemeral thread")

        # Cancel: the running turn is interrupted and its answer never sent.
        translator.translate("c", "[translate-hold] This one waits.")
        until = time.monotonic() + 20
        while (
            not (translator.active and translator.active.turn_id)
            and time.monotonic() < until
        ):
            time.sleep(0.02)
        translator.cancel("c")
        until = time.monotonic() + 20
        while (
            not [e for e in log(home) if e["method"] == "turn/interrupt"]
            and time.monotonic() < until
        ):
            time.sleep(0.02)
        assert [
            e for e in log(home) if e["method"] == "turn/interrupt"
        ], "Cancel interrupts the turn"
        translator.translate("d", "After the cancel.")
        assert inbox.final("d")["text"] == "译文：After the cancel."
        assert not [m for m in inbox.of("c") if m.get("done") or m.get("error")]
        # A request cancelled while still queued never starts.
        translator.translate("e", "[translate-hold] Holding again.")
        translator.translate("f", "Never sent.")
        translator.cancel("f")
        until = time.monotonic() + 20
        while (
            not (
                translator.active
                and translator.active.id == "e"
                and translator.active.turn_id
            )
            and time.monotonic() < until
        ):
            time.sleep(0.02)
        translator.cancel("e")
        translator.translate("g", "Next.")
        assert inbox.final("g")["text"] == "译文：Next."
        texts = [
            e["params"]["input"][0]["text"]
            for e in log(home)
            if e["method"] == "turn/start"
        ]
        assert "Never sent." not in texts
        print("PASS cancel interrupts a running translation and drops a queued one")

        translator.translate("h", "[translate-fail] Broken.")
        failed = inbox.final("h")
        assert failed["error"] == {
            "code": "failed",
            "message": "Fixture translation failed",
        }, failed
        translator.translate("i", "x" * (translate.LIMIT + 1))
        assert inbox.final("i")["error"]["code"] == "too_long"
        print("PASS a failed turn and an oversized text answer with an error")

        # A turn that never finishes: the translator gives up, interrupts it and says so.
        interrupts = len([e for e in log(home) if e["method"] == "turn/interrupt"])
        with patch.object(translate, "TURN_SECONDS", 0.5):
            translator.translate("t", "[translate-hold] Codex never answers this.")
            slow = inbox.final("t")
        assert slow["error"]["code"] == "timeout", slow
        assert not [m for m in inbox.of("t") if "delta" in m]
        assert (
            len([e for e in log(home) if e["method"] == "turn/interrupt"])
            == interrupts + 1
        )
        translator.translate("u", "After the timeout.")
        assert inbox.final("u")["text"] == "译文：After the timeout."
        print(
            "PASS a turn past the time limit is interrupted and answered with a timeout"
        )

        # A long-lived thread is replaced; the old one is released.
        with patch.object(translate, "ROTATE_TURNS", translator.turns + 1):
            translator.translate("j", "Rotate after this.")
            assert inbox.final("j")["text"] == "译文：Rotate after this."
            until = time.monotonic() + 20
            while (
                len([e for e in log(home) if e["method"] == "thread/start"]) < 2
                and time.monotonic() < until
            ):
                time.sleep(0.02)
        assert len([e for e in log(home) if e["method"] == "thread/start"]) == 2
        translator.translate("k", "On the new thread.")
        assert inbox.final("k")["text"] == "译文：On the new thread."
        threads = [
            e["params"]["threadId"] for e in log(home) if e["method"] == "turn/start"
        ]
        assert threads[-1] != threads[0]
        print("PASS a thread is replaced after enough translations")
    finally:
        translator.close()
    assert translator.process is None

    # Codex missing, signed out, and a crash in the middle of a turn.
    inbox = Inbox()
    missing = translate.Translator(home, lambda: None, inbox)
    missing.translate("m", "Hello there.")
    assert inbox.final("m")["error"]["code"] == "codex_missing"
    missing.close()
    signed_out = (
        "import json,sys\n"
        "for line in sys.stdin:\n"
        " m=json.loads(line)\n"
        " if 'id' not in m: continue\n"
        " r={'account':None,'requiresOpenaiAuth':True} if m['method']=='account/read' else {}\n"
        " print(json.dumps({'id':m['id'],'result':r}),flush=True)\n"
    )
    out = translate.Translator(home, lambda: launcher(home, code=signed_out), inbox)
    out.translate("n", "Hello there.")
    assert inbox.final("n")["error"]["code"] == "signed_out"
    assert out.process is None, "A signed-out app-server is not kept"
    out.close()
    crash = (
        "import json,sys\n"
        "for line in sys.stdin:\n"
        " m=json.loads(line)\n"
        " if 'id' not in m: continue\n"
        " if m['method']=='turn/start' and 'Hello.' not in json.dumps(m): sys.exit(1)\n"
        " r={'account':{'type':'chatgpt'}} if m['method']=='account/read' else {'thread':{'id':'t'}} if m['method']=='thread/start' else {'turn':{'id':'u'}} if m['method']=='turn/start' else {}\n"
        " print(json.dumps({'id':m['id'],'result':r}),flush=True)\n"
        " if m['method']=='turn/start': print(json.dumps({'method':'turn/completed','params':{'threadId':'t','turn':{'id':'u','status':'completed'}}}),flush=True)\n"
    )
    broken = translate.Translator(home, lambda: launcher(home, code=crash), inbox)
    broken.translate("o", "Hello there, crash.")
    assert inbox.final("o")["error"]["code"] in ("disconnected", "timeout"), inbox.of(
        "o"
    )
    broken.close()
    print(
        "PASS missing Codex, a signed-out account and a crashed app-server answer with a reason"
    )
