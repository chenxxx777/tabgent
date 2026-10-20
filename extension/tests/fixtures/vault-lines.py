"""Line-delimited vault requests for JS tests: the real vault module, a temporary folder."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native"))
import feeds
import vault

settings = Path(sys.argv[1])
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if isinstance(method, str) and method.startswith("vault/feeds/"):
        reply = feeds.handle(settings, method, message.get("params"))
    else:
        reply = vault.handle(settings, method, message.get("params"))
    sys.stdout.write(json.dumps({"id": message.get("id"), **reply}) + "\n")
    sys.stdout.flush()
