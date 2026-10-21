"""Images saved with a clipped webpage: vault/clip/asset stages each image from base64
chunks (resumable, checked against its SHA-256), and vault/clip/save moves staged images
into the page folder's assets/, refuses a clip whose images are missing before writing
anything, and removes images an earlier clip saved that the new one does not use. Uses
generated, non-sensitive bytes.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "native"))
import vault

URL = "https://example.test/essays/images"
PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 40
JPEG = b"\xff\xd8\xff\xe0" + b"fixture jpeg " * 300
GIF = b"GIF89a" + b"fixture gif " * 50


def digest(data):
    return hashlib.sha256(data).hexdigest()


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, (method, reply)
    return reply["result"]


def code(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"error"}, (method, reply)
    return reply["error"]["code"]


def upload(settings, data, chunk=1000):
    sha = digest(data)
    reply = call(
        settings,
        "vault/clip/asset",
        {"sha256": sha, "size": len(data), "offset": 0, "data": ""},
    )
    while not reply["complete"]:
        offset = reply["received"]
        reply = call(
            settings,
            "vault/clip/asset",
            {
                "sha256": sha,
                "size": len(data),
                "offset": offset,
                "data": base64.b64encode(data[offset : offset + chunk]).decode(),
            },
        )
    return sha


def asset(data, ext, source):
    return {"sha256": digest(data), "ext": ext, "size": len(data), "source": source}


def clip(settings, assets, **extra):
    return call(
        settings,
        "vault/clip/save",
        {
            "url": URL,
            "title": "Images",
            "kind": "web",
            "markdown": "![Chart](assets/x.png)",
            "html": '<p><img data-remote-src="https://cdn.example.test/chart.png"></p>',
            "origin": {"method": "article"},
            "images": {"found": len(assets), "saved": len(assets), "remote": 0},
            "assets": assets,
            **extra,
        },
    )


with tempfile.TemporaryDirectory(prefix="tabgent-clip-assets-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    root = base / "ReadingVault"
    uploads = root / ".tabgent/uploads"
    with patch.object(vault, "default_path", lambda: root):
        # A progress check for an unknown image writes nothing.
        assert call(
            settings,
            "vault/clip/asset",
            {"sha256": digest(PNG), "size": len(PNG), "offset": 0, "data": ""},
        ) == {"complete": False, "received": 0}
        assert not root.exists()

        # Chunks in order; an interrupted upload resumes; the last chunk is verified.
        first = call(
            settings,
            "vault/clip/asset",
            {
                "sha256": digest(PNG),
                "size": len(PNG),
                "offset": 0,
                "data": base64.b64encode(PNG[:4000]).decode(),
            },
        )
        assert first == {"complete": False, "received": 4000}
        # A chunk at the wrong offset is ignored; the reply says where to continue.
        assert call(
            settings,
            "vault/clip/asset",
            {
                "sha256": digest(PNG),
                "size": len(PNG),
                "offset": 9000,
                "data": base64.b64encode(PNG[9000:9100]).decode(),
            },
        ) == {"complete": False, "received": 4000}
        assert upload(settings, PNG) == digest(PNG)
        assert (uploads / f"asset-{digest(PNG)}.ready").read_bytes() == PNG
        assert not (uploads / f"asset-{digest(PNG)}.part").exists()
        # Uploading it again is complete at once.
        assert call(
            settings,
            "vault/clip/asset",
            {"sha256": digest(PNG), "size": len(PNG), "offset": 0, "data": ""},
        )["complete"]
        # Bytes that do not match their hash are refused and dropped.
        wrong = "0" * 64
        assert (
            code(
                settings,
                "vault/clip/asset",
                {
                    "sha256": wrong,
                    "size": 4,
                    "offset": 0,
                    "data": base64.b64encode(b"abcd").decode(),
                },
            )
            == "invalid_params"
        )
        assert not (uploads / f"asset-{wrong}.part").exists()
        for bad in (
            {"sha256": "XYZ", "size": 4, "offset": 0},
            {"sha256": wrong, "size": 0, "offset": 0},
            {"sha256": wrong, "size": vault.CLIP_ASSET_LIMIT + 1, "offset": 0},
            {"sha256": wrong, "size": 4, "offset": 0, "data": "not base64!"},
            {"sha256": wrong, "size": 2, "offset": 0, "data": "YWJjZA=="},
        ):
            assert code(settings, "vault/clip/asset", bad) == "invalid_params", bad
        print("PASS clip images upload in resumable chunks checked against their hash")

        # A clip whose images were not all uploaded writes nothing at all.
        missing = asset(JPEG, "jpg", "https://cdn.example.test/photo.jpg")
        assert (
            code(
                settings,
                "vault/clip/save",
                {
                    "url": URL,
                    "title": "Images",
                    "kind": "web",
                    "markdown": "Text.",
                    "html": "<p>Text.</p>",
                    "origin": {"method": "article"},
                    "assets": [missing],
                },
            )
            == "missing_asset"
        )
        assert not (root / "Articles").exists() or not any(
            (root / "Articles").iterdir()
        )

        # Saving moves the staged image into assets/ and records it.
        chart = asset(PNG, "png", "https://cdn.example.test/chart.png")
        saved = clip(settings, [chart])
        folder = Path(saved["document"]["folder"])
        name = f"{digest(PNG)[:16]}.png"
        assert (folder / "assets" / name).read_bytes() == PNG
        # The staged copy stays for other clips that use the same image; it is pruned later.
        assert (uploads / f"asset-{digest(PNG)}.ready").read_bytes() == PNG
        record = json.loads((folder / "article.json").read_text())
        assert record["assets"] == [
            {
                "file": f"assets/{name}",
                "sha256": digest(PNG),
                "size": len(PNG),
                "mime": "image/png",
                "source": "https://cdn.example.test/chart.png",
                "sources": ["https://cdn.example.test/chart.png"],
            }
        ]
        summary = saved["clip"]
        assert summary["imagesSaved"] == 1
        assert summary["bytes"] == (
            record["files"]["markdown"]["bytes"]
            + record["files"]["html"]["bytes"]
            + len(PNG)
        )
        print("PASS a clip moves its uploaded images into assets/ and records them")

        # The page's cover is one of the clip's images: recorded with its address, written
        # in the front matter, reported to the library and readable like the other images.
        # Where the author, date and cover came from, and what the clip holds, are recorded.
        cover = {
            "source": "https://cdn.example.test/chart.png",
            "file": f"assets/{name}",
        }
        sources = {"author": "site:example.test", "publishedAt": "title-line"}
        covered = clip(
            settings,
            [chart],
            replace=True,
            cover=cover,
            metaSources={**sources, "unknown": "ignored"},
            contentStatus="text",
        )
        record = json.loads((folder / "article.json").read_text())
        assert record["cover"] == cover
        assert record["metaSources"] == sources and record["contentStatus"] == "text"
        assert covered["clip"]["cover"] == cover["file"]
        assert covered["clip"]["contentStatus"] == "text"
        front = (folder / "article.md").read_text().split("\n---\n", 1)[0]
        assert f'\ncover: "{cover["file"]}"' in front, front
        read = call(
            settings,
            "vault/clip/read",
            {"documentId": covered["document"]["id"]},
        )["clip"]
        assert read["cover"] == cover and read["metaSources"] == sources
        assert read["contentStatus"] == "text"
        image = call(
            settings,
            "vault/clip/asset/read",
            {"documentId": covered["document"]["id"], "file": cover["file"]},
        )
        assert base64.b64decode(image["data"]) == PNG
        # A cover that could not be saved keeps its address; a clip of only links says so.
        remote = {"source": "https://cdn.example.test/cover.jpg", "file": ""}
        links = clip(
            settings, [chart], replace=True, cover=remote, contentStatus="linksOnly"
        )
        record = json.loads((folder / "article.json").read_text())
        assert record["cover"] == remote and record["metaSources"] == {}
        assert (
            links["clip"]["cover"] == ""
            and links["clip"]["contentStatus"] == "linksOnly"
        )
        assert (
            '\ncover: "https://cdn.example.test/cover.jpg"'
            in (folder / "article.md").read_text()
        )
        listed = call(settings, "vault/documents/list", {})["documents"]
        entry = next(d for d in listed if d["id"] == links["document"]["id"])
        assert entry["clip"]["contentStatus"] == "linksOnly"
        # Records written before these fields read as a clip of the page's text.
        old = dict(record)
        for key in ("cover", "metaSources", "contentStatus"):
            old.pop(key)
        (folder / "article.json").write_text(json.dumps(old))
        listed = call(settings, "vault/documents/list", {})["documents"]
        entry = next(d for d in listed if d["id"] == links["document"]["id"])
        assert entry["clip"]["contentStatus"] == "text" and entry["clip"]["cover"] == ""
        # A cover that is not one of the clip's images, or not a web address, an unknown
        # status and a source that is not a short name are refused, and nothing is written.
        before = (folder / "article.json").read_bytes()
        for bad in (
            {
                "cover": {
                    "source": cover["source"],
                    "file": "assets/0000000000000000.png",
                }
            },
            {"cover": {"source": "file:///etc/hosts", "file": ""}},
            {"cover": "https://cdn.example.test/chart.png"},
            {"contentStatus": "complete"},
            {"metaSources": {"author": "Site Rule!"}},
            {"metaSources": ["metadata"]},
        ):
            reply = vault.handle(
                settings,
                "vault/clip/save",
                {
                    "url": URL,
                    "title": "Images",
                    "kind": "web",
                    "markdown": "text",
                    "html": "<p>text</p>",
                    "origin": {"method": "article"},
                    "assets": [chart],
                    "replace": True,
                    **bad,
                },
            )
            assert reply["error"]["code"] == "invalid_params", (bad, reply)
        assert (folder / "article.json").read_bytes() == before
        print("PASS a clip records its cover, metadata sources and links-only status")

        # A new clip reuses a saved image without uploading it again, adds a new one, and
        # removes the image the old clip used; files the user put in assets/ stay.
        (folder / "assets" / "my-sketch.png").write_bytes(b"user file")
        upload(settings, GIF)
        upload(settings, JPEG)
        replaced = clip(
            settings,
            [chart, asset(GIF, "gif", "https://cdn.example.test/anim.gif")],
            replace=True,
        )
        assert replaced["saved"] is True
        names = sorted(path.name for path in (folder / "assets").iterdir())
        assert names == sorted(
            [name, f"{digest(GIF)[:16]}.gif", "my-sketch.png"]
        ), names
        again = clip(
            settings,
            [asset(JPEG, "jpg", "https://cdn.example.test/photo.jpg")],
            replace=True,
        )
        assert again["saved"] is True
        names = sorted(path.name for path in (folder / "assets").iterdir())
        assert names == sorted([f"{digest(JPEG)[:16]}.jpg", "my-sketch.png"]), names
        print("PASS a new clip reuses, adds and removes its images; other files stay")

        # Two pages that share an image, clipped at the same time: the image is uploaded once
        # (the second upload finds it staged) and both clips save it.
        shared = b"GIF89a shared logo " * 20
        upload(settings, shared)
        logo = asset(shared, "gif", "https://cdn.example.test/logo.gif")
        assert call(
            settings,
            "vault/clip/asset",
            {"sha256": digest(shared), "size": len(shared), "offset": 0, "data": ""},
        ) == {"complete": True, "received": len(shared)}
        pages = []
        for path in ("/first", "/second"):
            pages.append(
                call(
                    settings,
                    "vault/clip/save",
                    {
                        "url": URL + path,
                        "title": "Shared " + path,
                        "kind": "web",
                        "markdown": "Logo.",
                        "html": "<p>Logo.</p>",
                        "origin": {"method": "article"},
                        "assets": [logo],
                    },
                )
            )
        for saved_page in pages:
            files = Path(saved_page["document"]["folder"]) / "assets"
            assert (files / f"{digest(shared)[:16]}.gif").read_bytes() == shared
        print("PASS clips that share an image both save it")

        # When the user edited article.md, its kept copy still links the earlier images:
        # they stay in assets/.
        photo = f"{digest(JPEG)[:16]}.jpg"
        (folder / "article.md").write_text(f"Edited, with ![photo](assets/{photo}).\n")
        upload(settings, PNG)
        edited = clip(settings, [chart], replace=True)
        assert edited["backup"].startswith("article-edited-")
        names = sorted(path.name for path in (folder / "assets").iterdir())
        assert names == sorted(
            [name, f"{digest(JPEG)[:16]}.jpg", "my-sketch.png"]
        ), names
        # The next clip without an edited copy removes what neither clip uses.
        again = clip(
            settings,
            [asset(JPEG, "jpg", "https://cdn.example.test/photo.jpg")],
            replace=True,
        )
        assert again["backup"] is None
        names = sorted(path.name for path in (folder / "assets").iterdir())
        assert names == sorted([photo, "my-sketch.png"]), names
        # A later clip that drops the photo keeps it too: the edited copy still links it.
        upload(settings, PNG)
        later = clip(settings, [chart], replace=True)
        assert later["backup"] is None
        names = sorted(path.name for path in (folder / "assets").iterdir())
        assert names == sorted([name, photo, "my-sketch.png"]), names
        # Back to the photo, which later checks read.
        clip(
            settings,
            [asset(JPEG, "jpg", "https://cdn.example.test/photo.jpg")],
            replace=True,
        )
        print("PASS the images of an edited article.md are kept with it")

        # An assets/ that is a symbolic link is refused before anything is written.
        os.rename(folder / "assets", base / "elsewhere")
        os.symlink(base / "elsewhere", folder / "assets")
        before = (folder / "article.md").read_bytes()
        upload(settings, PNG)
        assert (
            code(
                settings,
                "vault/clip/save",
                {
                    "url": URL,
                    "title": "Images",
                    "kind": "web",
                    "markdown": "Other text.",
                    "html": "<p>Other.</p>",
                    "origin": {"method": "article"},
                    "assets": [chart],
                    "replace": True,
                },
            )
            == "io_error"
        )
        assert (folder / "article.md").read_bytes() == before
        os.unlink(folder / "assets")
        os.rename(base / "elsewhere", folder / "assets")

        # Invalid image lists are refused.
        good = asset(PNG, "png", "https://cdn.example.test/chart.png")
        for assets in (
            [good, good],
            [{**good, "ext": "svg"}],
            [{**good, "source": "javascript:alert(1)"}],
            [{**good, "sources": ["javascript:alert(1)"]}],
            [{**good, "sources": "https://cdn.example.test/a.png"}],
            [{**good, "sources": ["https://x.test/"] * (vault.CLIP_ASSET_COUNT + 1)}],
            [{**good, "size": 0}],
            [{**good, "size": vault.CLIP_ASSET_LIMIT + 1}],
            [
                {**good, "sha256": f"{i:064x}", "size": vault.CLIP_ASSET_LIMIT}
                for i in range(7)
            ],
            [
                {**good, "sha256": f"{i:064x}"}
                for i in range(vault.CLIP_ASSET_COUNT + 1)
            ],
            "assets",
        ):
            params = {
                "url": URL,
                "title": "Images",
                "kind": "web",
                "markdown": "Text.",
                "html": "<p>Text.</p>",
                "origin": {"method": "article"},
                "assets": assets,
                "replace": True,
            }
            assert code(settings, "vault/clip/save", params) == "invalid_params"
        assert (
            code(
                settings,
                "vault/clip/save",
                {
                    "url": URL,
                    "title": "Images",
                    "kind": "web",
                    "markdown": "Text.",
                    "html": "<p>Text.</p>",
                    "origin": {"method": "article"},
                    "images": {"failed": [{"reason": "no source"}]},
                },
            )
            == "invalid_params"
        )
        print("PASS invalid image lists and a linked assets folder are refused")

        # The reader reads article.html and the recorded images in chunks.
        ident = again["document"]["id"]
        html = (folder / "article.html").read_bytes()
        parts, offset = [], 0
        while True:
            chunk = call(
                settings,
                "vault/clip/read",
                {"documentId": ident, "offset": offset, "length": 100},
            )
            parts.append(base64.b64decode(chunk["data"]))
            offset += 100
            if chunk["eof"]:
                break
        assert b"".join(parts) == html and chunk["size"] == len(html)
        assert chunk["clip"]["html"]["sha256"] == digest(html)
        assert (
            chunk["clip"]["assets"][0]["source"] == "https://cdn.example.test/photo.jpg"
        )
        assert chunk["clip"]["summary"]["complete"] is True
        assert chunk["document"]["url"] == URL
        jpg = f"assets/{digest(JPEG)[:16]}.jpg"
        image = call(
            settings,
            "vault/clip/asset/read",
            {"documentId": ident, "file": jpg, "length": vault.CHUNK_LIMIT},
        )
        assert base64.b64decode(image["data"]) == JPEG
        assert image["mime"] == "image/jpeg" and image["eof"] is True
        # Only images the clip recorded, at their exact place.
        for file in ("assets/my-sketch.png", f"assets/{digest(PNG)[:16]}.png"):
            assert code(
                settings, "vault/clip/asset/read", {"documentId": ident, "file": file}
            ) in ("invalid_params", "not_found"), file
        for file in (
            "article.md",
            "../anchors.json",
            f"assets/../{jpg}",
            "assets/x.svg",
        ):
            assert (
                code(
                    settings,
                    "vault/clip/asset/read",
                    {"documentId": ident, "file": file},
                )
                == "invalid_params"
            ), file
        target = folder / jpg
        os.rename(target, base / "outside.jpg")
        os.symlink(base / "outside.jpg", target)
        assert (
            code(settings, "vault/clip/asset/read", {"documentId": ident, "file": jpg})
            == "not_found"
        )
        os.unlink(target)
        os.rename(base / "outside.jpg", target)
        print("PASS the reader reads the clip and its recorded images in chunks")

        # Deleting the clip keeps the page's notes, an edited article.md and the user's files.
        call(
            settings,
            "vault/highlight/create",
            {
                "url": URL,
                "title": "Images",
                "kind": "web",
                "text": "Text",
                "anchor": {"kind": "web", "quote": {"exact": "Text"}},
            },
        )
        (folder / "article.md").write_text("Edited by me.\n")
        deleted = call(settings, "vault/clip/delete", {"documentId": ident})
        assert deleted["ok"] is True and deleted["backup"].startswith("article-edited-")
        remaining = sorted(
            path.name
            for path in folder.iterdir()
            if not path.name.startswith("article-edited-")
        )
        assert remaining == ["anchors.json", "assets", "highlights.md"], remaining
        assert (folder / deleted["backup"]).read_text() == "Edited by me.\n"
        assert not (folder / "article.json").exists()
        # The kept edited copy may link the clip's images, so they stay with it.
        assert sorted(path.name for path in (folder / "assets").iterdir()) == sorted(
            [f"{digest(JPEG)[:16]}.jpg", "my-sketch.png"]
        )
        assert (
            call(
                settings,
                "vault/document/resolve",
                {"url": URL, "title": "", "kind": "web"},
            )["clip"]
            is None
        )
        assert code(settings, "vault/clip/read", {"documentId": ident}) == "not_found"
        assert call(settings, "vault/clip/delete", {"documentId": ident}) == {
            "ok": True,
            "backup": None,
        }
        assert (
            code(
                settings,
                "vault/clip/delete",
                {"documentId": "article-missing-00000000"},
            )
            == "not_found"
        )
        print("PASS deleting a clip keeps the page's notes and the user's files")

        # Staged images that were never saved are removed after a day.
        stale = uploads / f"asset-{'1' * 64}.ready"
        stale.write_bytes(b"old")
        old = time.time() - vault.STALE_UPLOAD - 60
        os.utime(stale, (old, old))
        upload(settings, b"GIF89a fresh upload")
        assert not stale.exists()
        print("PASS abandoned image uploads are pruned")
