"""A stand-in Codex app-server for browser tests: no account, model, or network.

It answers Tabgent's setup requests and replays one completed turn for each
turn/start, echoing the user's input as Codex does. Threads with turns are kept
in CODEX_HOME so a restarted browser can resume them.

Directives in the user's text drive the rest, as a model would:
  [hold]          the turn keeps running until turn/steer or turn/interrupt;
  [browser-read]  calls the browser tool's read on the message's tabId;
  [vault-read:N]  calls reading_vault to read page N of the imported PDF named in the
                  message's reading context.
Each tool result is quoted in the answer, so tests can check what the tool returned.
"""

import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

store = Path(os.environ["CODEX_HOME"]) / "fixture-threads.json"
PAGE_CONTEXT = "Browser context for this message"
READING_CONTEXT = "Reading context for this message"
# Messages read while waiting for a tool result, handled after the current request.
backlog = []
held = None


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


def receive():
    if backlog:
        return backlog.pop(0)
    line = sys.stdin.readline()
    return json.loads(line) if line else None


def thread(ident, turns):
    return {
        "id": ident,
        "cwd": os.getcwd(),
        "preview": "",
        "name": None,
        "status": {"type": "idle"},
        "turns": turns,
    }


def context(parts, prefix):
    for part in parts:
        text = part.get("text") or ""
        if text.startswith(prefix):
            return json.loads(text[text.index("\n") + 1 :])
    return {}


def call_tool(ident, turn_id, tool, arguments):
    """Asks the client to run a dynamic tool and waits for its result."""
    request = "fixture-tool-" + uuid.uuid4().hex[:8]
    send(
        {
            "id": request,
            "method": "item/tool/call",
            "params": {
                "threadId": ident,
                "turnId": turn_id,
                "callId": request,
                "tool": tool,
                "arguments": arguments,
            },
        }
    )
    while True:
        line = sys.stdin.readline()
        if not line:
            raise EOFError
        message = json.loads(line)
        if message.get("id") == request and "method" not in message:
            result = message.get("result") or {}
            text = " ".join(
                item.get("text", "") for item in result.get("contentItems") or []
            )
            return f"{tool} {'ok' if result.get('success') else 'failed'}: {text}"
        backlog.append(message)


def tools(ident, turn_id, parts):
    """Runs the tool directives in the user's text; returns their results."""
    text = " ".join(part.get("text") or "" for part in parts)
    results = []
    if "[browser-read]" in text:
        page = context(parts, PAGE_CONTEXT)
        results.append(
            call_tool(
                ident, turn_id, "browser", {"action": "read", "tabId": page["tabId"]}
            )
        )
    for number in re.findall(r"\[vault-read:(\d{3})\]", text):
        reading = context(parts, READING_CONTEXT)
        vault = reading["vault"]["path"].rstrip("/")
        pages = reading["document"]["pages"]
        results.append(
            call_tool(
                ident,
                turn_id,
                "reading_vault",
                {
                    "action": "read",
                    "path": os.path.relpath(f"{pages}/{number}.md", vault),
                },
            )
        )
    return results


def finish(turn, status="completed", answer=None):
    items = turn["items"]
    if answer is not None:
        item = {
            "id": turn["id"] + "-answer",
            "type": "agentMessage",
            "text": answer,
            "phase": "final_answer",
        }
        for method in ("item/started", "item/completed"):
            send(
                {
                    "method": method,
                    "params": {
                        "threadId": turn["threadId"],
                        "turnId": turn["id"],
                        "item": item,
                    },
                }
            )
        items = [*items, item]
    done = {
        "id": turn["id"],
        "status": status,
        "items": items,
        "startedAt": turn["started"],
        "completedAt": turn["started"] + 1,
    }
    threads = load()
    threads[turn["threadId"]] = [*threads.get(turn["threadId"], []), done]
    save(threads)
    send(
        {
            "method": "turn/completed",
            "params": {"threadId": turn["threadId"], "turn": done},
        }
    )


def user_item(turn, ident, params):
    # Like Codex, the item names the client's message ID so the view can match it.
    item = {
        "id": ident,
        "type": "userMessage",
        "content": params["input"],
        **(
            {"clientId": params["clientUserMessageId"]}
            if params.get("clientUserMessageId")
            else {}
        ),
    }
    for method in ("item/started", "item/completed"):
        send(
            {
                "method": method,
                "params": {
                    "threadId": turn["threadId"],
                    "turnId": turn["id"],
                    "item": item,
                },
            }
        )
    turn["items"].append(item)


def replay(request):
    global held
    params = request["params"]
    ident = params["threadId"]
    turn_id = "turn-" + uuid.uuid4().hex[:12]
    turn = {
        "id": turn_id,
        "threadId": ident,
        "number": len(load().get(ident, [])) + 1,
        "started": int(time.time()),
        "items": [],
    }
    running = {"id": turn_id, "status": "inProgress", "items": []}
    send({"id": request["id"], "result": {"turn": running}})
    send({"method": "turn/started", "params": {"threadId": ident, "turn": running}})
    user_item(turn, turn_id + "-user", params)
    if any("[hold]" in (part.get("text") or "") for part in params["input"]):
        held = turn
        return
    answer = " ".join(
        [f"Fixture answer {turn['number']}.", *tools(ident, turn_id, params["input"])]
    )
    finish(turn, answer=answer)


while (request := receive()) is not None:
    if "id" not in request or "method" not in request:
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
    elif method == "turn/steer":
        if not held or params.get("expectedTurnId") != held["id"]:
            send(
                {
                    "id": request["id"],
                    "error": {"code": -32600, "message": "no active turn to steer"},
                }
            )
            continue
        turn, held = held, None
        send({"id": request["id"], "result": {"turnId": turn["id"]}})
        user_item(turn, turn["id"] + "-steer", params)
        finish(turn, answer=f"Fixture answer {turn['number']} (steered).")
        continue
    elif method == "turn/interrupt":
        send({"id": request["id"], "result": {}})
        if held and params.get("turnId") == held["id"]:
            turn, held = held, None
            finish(turn, status="interrupted")
        continue
    send({"id": request["id"], "result": result})
