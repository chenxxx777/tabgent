"""A stand-in Codex app-server for browser tests: no account, model, or network.

It answers Tabgent's setup requests and replays one completed turn for each
turn/start, echoing the user's input as Codex does. Threads with turns are kept
in CODEX_HOME so a restarted browser can resume them.
"""

import json
import os
from pathlib import Path
import sys
import time
import uuid

store = Path(os.environ["CODEX_HOME"]) / "fixture-threads.json"


def load():
    try:
        return json.loads(store.read_text())
    except (OSError, ValueError):
        return {}


def save(threads):
    temporary = store.with_suffix(".tmp")
    temporary.write_text(json.dumps(threads))
    temporary.replace(store)


def send(message):
    print(json.dumps(message), flush=True)


def thread(ident, turns):
    return {
        "id": ident,
        "cwd": os.getcwd(),
        "preview": "",
        "name": None,
        "status": {"type": "idle"},
        "turns": turns,
    }


def replay(request):
    params = request["params"]
    ident = params["threadId"]
    threads = load()
    turns = threads.get(ident, [])
    turn_id = "turn-" + uuid.uuid4().hex[:12]
    started = int(time.time())
    items = [
        {"id": turn_id + "-user", "type": "userMessage", "content": params["input"]},
        {
            "id": turn_id + "-answer",
            "type": "agentMessage",
            "text": f"Fixture answer {len(turns) + 1}.",
            "phase": "final_answer",
        },
    ]
    running = {"id": turn_id, "status": "inProgress", "items": []}
    send({"id": request["id"], "result": {"turn": running}})
    send({"method": "turn/started", "params": {"threadId": ident, "turn": running}})
    for item in items:
        for method in ("item/started", "item/completed"):
            send(
                {
                    "method": method,
                    "params": {"threadId": ident, "turnId": turn_id, "item": item},
                }
            )
    turn = {
        **running,
        "status": "completed",
        "items": items,
        "startedAt": started,
        "completedAt": started + 1,
    }
    threads[ident] = [*turns, turn]
    save(threads)
    send({"method": "turn/completed", "params": {"threadId": ident, "turn": turn}})


for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method, params = request.get("method"), request.get("params") or {}
    result = {"data": []}
    if method == "initialize":
        result = {"userAgent": "tabgent-fixture"}
    elif method == "project/create":
        result = {"project": {"id": "fixture", "roots": [{"path": os.getcwd()}]}}
    elif method == "account/read":
        result = {"account": {"type": "apiKey"}, "requiresOpenaiAuth": True}
    elif method == "model/list":
        result = {
            "data": [
                {
                    "model": "fixture",
                    "displayName": "Fixture",
                    "isDefault": True,
                    "supportedReasoningEfforts": [{"reasoningEffort": "medium"}],
                    "defaultReasoningEffort": "medium",
                }
            ]
        }
    elif method == "thread/start":
        # Like Codex, a thread is stored only once it has a turn.
        result = {"thread": thread(str(uuid.uuid4()), []), "model": "fixture"}
    elif method in ("thread/resume", "thread/read"):
        threads = load()
        if params.get("threadId") not in threads:
            send(
                {
                    "id": request["id"],
                    "error": {
                        "code": -32600,
                        "message": "no rollout found for thread id "
                        + str(params.get("threadId")),
                    },
                }
            )
            continue
        result = {
            "thread": thread(params["threadId"], threads[params["threadId"]]),
            "model": "fixture",
        }
    elif method == "thread/goal/get":
        result = {"goal": None}
    elif method == "turn/start":
        replay(request)
        continue
    send({"id": request["id"], "result": result})
