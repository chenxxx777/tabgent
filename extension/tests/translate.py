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

for message in (
    "The requested service tier is not allowed for this project",
    "Fast mode is only available for an eligible plan",
    "Unknown service_tier priority",
    "Priority processing requires a paid subscription",
):
    assert translate.fast_unavailable(translate.TranslateError("failed", message))
for message in ("Fixture translation failed", "Codex stopped", "Invalid input text"):
    assert not translate.fast_unavailable(translate.TranslateError("failed", message))


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
        assert params["serviceTier"] == "priority"
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
        assert turn["serviceTierForTurn"] == "priority", turn
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

    # Cold-start and rotation warm-ups must yield even when their turn/start
    # response has not reached the worker yet.
    for rotated in (False, True):
        inbox = Inbox()
        priority = translate.Translator(home, lambda: launcher(home), inbox)
        started, release = threading.Event(), threading.Event()
        rpc = priority._rpc

        def delayed_rpc(method, params=None):
            result = rpc(method, params)
            if method == "turn/start" and params["input"][0]["text"].startswith(
                "[translate-hold]"
            ):
                started.set()
                assert release.wait(5)
            return result

        try:
            priority._rpc = delayed_rpc
            with patch.object(translate, "WARM_TEXT", "[translate-hold] Warm."):
                if rotated:
                    priority.translate("before", "Before rotation.")
                    inbox.final("before")
                    priority._rotate()
                    priority.jobs.put(None)
                else:
                    priority.warm()
                assert started.wait(5), "The speculative warm-up started"
                priority.translate("priority", "A real selection.")
                release.set()
                assert inbox.final("priority")["text"] == "译文：A real selection."
                assert not inbox.of("warm"), "Warm-up output is never published"
            print("PASS real work preempts warm-up before its turn/start response")
        finally:
            release.set()
            priority.close()

    # Keep a starting job cancellable while account/read and thread/start run.
    inbox = Inbox()
    starting = translate.Translator(home, lambda: launcher(home), inbox)
    entered, release = threading.Event(), threading.Event()
    ensure = starting._ensure

    def delayed_ensure():
        entered.set()
        assert release.wait(5)
        ensure()

    starting._ensure = delayed_ensure
    try:
        starting.translate("startup-cancel", "[translate-hold] Cancel at startup.")
        assert entered.wait(5)
        starting.cancel("startup-cancel")
        release.set()
        starting.translate("next", "After cancelling startup.")
        assert inbox.final("next")["text"] == "译文：After cancelling startup."
        assert not inbox.of("startup-cancel")
        assert not any(
            e["method"] == "turn/start"
            and e["params"]["input"][0]["text"] == "[translate-hold] Cancel at startup."
            for e in log(home)
        )
        print("PASS a selection cancelled during startup never reaches the model")
    finally:
        release.set()
        starting.close()

    # Fast may be rejected by turn/start itself or by a later turn error. Neither
    # failure reaches the page before the one standard-speed retry completes.
    for tag in ("[translate-fast-rpc-denied]", "[translate-fast-denied]"):
        inbox = Inbox()
        fallback = translate.Translator(home, lambda: launcher(home), inbox)
        before = len(log(home))
        text = f"{tag} This account can still translate at standard speed."
        try:
            fallback.translate("fallback", text)
            assert inbox.final("fallback")["text"] == "译文：" + text
            assert not [m for m in inbox.of("fallback") if m.get("error")]
            attempts = [e for e in log(home)[before:] if e["method"] == "turn/start"]
            assert [e["params"]["serviceTierForTurn"] for e in attempts] == [
                "priority",
                "default",
            ], attempts
            assert all(e["params"]["model"] == "gpt-6-luna" for e in attempts)
            assert all(e["params"]["effort"] == "low" for e in attempts)
            fallback.translate("sticky", "Next selection.")
            assert inbox.final("sticky")["text"] == "译文：Next selection."
            assert log(home)[-1]["params"]["serviceTierForTurn"] == "default"
            fallback._rotate()
            started = [e for e in log(home)[before:] if e["method"] == "thread/start"]
            assert started[-1]["params"]["serviceTier"] == "default"
            print(
                "PASS Fast rejection retries once at standard speed and retains fallback"
            )
        finally:
            fallback.close()

    # A rejected thread preference must also recover before a translation turn exists.
    inbox = Inbox()
    rejected = translate.Translator(home, lambda: launcher(home), inbox)
    original_rpc = rejected._rpc
    thread_tiers = []

    def reject_fast_thread(method, params=None):
        if method == "thread/start":
            thread_tiers.append(params["serviceTier"])
            if params["serviceTier"] == "priority":
                raise translate.TranslateError(
                    "failed", "Fast service_tier is not supported for this subscription"
                )
        return original_rpc(method, params)

    rejected._rpc = reject_fast_thread
    try:
        rejected.translate("thread-fallback", "Still translate this selection.")
        assert (
            inbox.final("thread-fallback")["text"]
            == "译文：Still translate this selection."
        )
        assert thread_tiers == ["priority", "default"]
        assert log(home)[-1]["params"]["serviceTierForTurn"] == "default"
        print(
            "PASS a rejected Fast thread preference retries with explicit standard tier"
        )
    finally:
        rejected.close()

    # Late events from the failed Fast attempt must not settle or corrupt its retry,
    # including before the standard attempt's turn/start response supplies a new id.
    inbox = Inbox()
    late = translate.Translator(home, lambda: launcher(home), inbox)
    original_rpc = late._rpc
    rejected_turn = None

    def late_fast_events(method, params=None):
        global rejected_turn
        if method == "turn/start" and params["serviceTierForTurn"] == "default":
            previous = {"threadId": params["threadId"], "turnId": rejected_turn}
            late._event("item/agentMessage/delta", {**previous, "delta": "stale"})
            late._event(
                "error", {**previous, "error": {"message": "stale"}, "willRetry": False}
            )
            late._event(
                "turn/completed",
                {**previous, "turn": {"id": rejected_turn, "status": "failed"}},
            )
        result = original_rpc(method, params)
        if method == "turn/start" and params["serviceTierForTurn"] == "priority":
            rejected_turn = result["turn"]["id"]
        return result

    late._rpc = late_fast_events
    try:
        text = "[translate-fast-denied] Ignore late Fast events."
        late.translate("late", text)
        assert inbox.final("late")["text"] == "译文：" + text
        assert "stale" not in "".join(m.get("delta", "") for m in inbox.of("late"))
        print("PASS late events from rejected Fast attempts cannot corrupt the retry")
    finally:
        late.close()

    # A standard failure terminates the retry; unrelated errors and partial output
    # must not be retried or concatenated with a new attempt.
    for text, expected_tiers, has_delta in (
        (
            "[translate-fast-denied] [translate-fail] Broken.",
            ["priority", "default"],
            False,
        ),
        ("[translate-fail] Broken.", ["priority"], False),
        ("[translate-fast-partial] Do not mix outputs.", ["priority"], True),
    ):
        inbox = Inbox()
        failed = translate.Translator(home, lambda: launcher(home), inbox)
        before = len(log(home))
        try:
            failed.translate("no-loop", text)
            assert inbox.final("no-loop")["error"]["code"] == "failed"
            attempts = [e for e in log(home)[before:] if e["method"] == "turn/start"]
            assert [
                e["params"]["serviceTierForTurn"] for e in attempts
            ] == expected_tiers
            assert bool([m for m in inbox.of("no-loop") if m.get("delta")]) == has_delta
        finally:
            failed.close()
    print(
        "PASS fallback is bounded and never retries unrelated errors or partial output"
    )

    # Cancellation during rejection remains attached to the active job and suppresses retry.
    inbox = Inbox()
    cancelled = translate.Translator(home, lambda: launcher(home), inbox)
    original_rpc = cancelled._rpc
    attempted = threading.Event()

    def cancel_rejected_turn(method, params=None):
        if method == "turn/start":
            cancelled.cancel("cancel-retry")
            attempted.set()
            raise translate.TranslateError("failed", "Fast tier unavailable")
        return original_rpc(method, params)

    cancelled._rpc = cancel_rejected_turn
    try:
        cancelled.translate("cancel-retry", "Cancel before the fallback.")
        assert attempted.wait(5)
        until = time.monotonic() + 5
        while cancelled.active and time.monotonic() < until:
            time.sleep(0.01)
        assert not inbox.of("cancel-retry")
        assert cancelled.service_tier == "priority"
        print("PASS cancellation before fallback produces no retry or terminal reply")
    finally:
        cancelled.close()
