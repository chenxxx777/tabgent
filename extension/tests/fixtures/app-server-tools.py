"""The fixture app-server, calling the browser tool as a model would.

It runs app-server-replay.py and passes every message through. When a turn/start
has user text lines `TOOL {json}`, it first calls the `browser` tool with each JSON
object as its arguments, in order, and appends the arguments and result of each
call to CODEX_HOME/fixture-tools.json. Browser tests read that file.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import threading

store = Path(os.environ["CODEX_HOME"]) / "fixture-tools.json"
replay = Path(__file__).with_name("app-server-replay.py")
inner = subprocess.Popen(
    [sys.executable, str(replay), *sys.argv[1:]],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)
out_lock, in_lock = threading.Lock(), threading.Lock()
pending = {}


def write(line):
    with out_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def forward(line):
    with in_lock:
        inner.stdin.write(line)
        inner.stdin.flush()


def relay():
    for line in inner.stdout:
        write(line)


def call(thread, request, arguments):
    done = threading.Event()
    pending[request] = {"done": done}
    write(
        json.dumps(
            {
                "id": request,
                "method": "item/tool/call",
                "params": {
                    "threadId": thread,
                    "callId": request,
                    "tool": "browser",
                    "arguments": arguments,
                },
            }
        )
        + "\n"
    )
    done.wait(60)
    return pending.pop(request).get("result")


def run(line, request, calls):
    thread = request["params"].get("threadId")
    results = [
        {
            "arguments": arguments,
            "result": call(thread, f"{request['id']}-{n}", arguments),
        }
        for n, arguments in enumerate(calls)
    ]
    try:
        recorded = json.loads(store.read_text())
    except (OSError, ValueError):
        recorded = []
    store.write_text(json.dumps([*recorded, *results]))
    forward(line)


threading.Thread(target=relay, daemon=True).start()
for line in sys.stdin:
    message = json.loads(line)
    if "method" not in message and message.get("id") in pending:
        pending[message["id"]]["result"] = message.get("result")
        pending[message["id"]]["done"].set()
        continue
    calls = [
        json.loads(text[5:])
        for part in (message.get("params") or {}).get("input") or []
        for text in (part.get("text") or "").splitlines()
        if text.startswith("TOOL ")
    ]
    if message.get("method") == "turn/start" and calls:
        threading.Thread(target=run, args=(line, message, calls), daemon=True).start()
    else:
        forward(line)
inner.stdin.close()
inner.wait()
