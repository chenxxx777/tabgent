# Development

Use Node.js 22+, Python 3.9+, and a recent Playwright Chromium installation.
The shipped extension has no Node.js runtime dependency and no build step.

```sh
npm ci
npx playwright install chromium
python3 extension/native/install.py --dev
npm run dev
```

`npm run dev` registers the source extension and launches a dedicated Chrome for
Testing profile. It does not reuse your everyday Chrome profile. Set `CHROME_PATH`
when using a different compatible browser binary. Set `CHROME_PROFILE` to choose
a different development profile. `PYTHON` selects a development Python command.

Reload the extension after frontend changes. Run the `--dev` installer again after
changing the native host. The installed native host intentionally runs outside
the source directory to avoid macOS protected-folder restrictions.

## Default checks

```sh
npm test
npm run format:check
```

The default suite checks syntax and English string references, scoped-browser
guards, selection ownership, DOM range capture, native disconnect reporting,
upload validation, and the chat UI with a controlled bridge. It also covers web
anchor build and restore, the highlight toolbar, and vault requests with a fake
connector port. EPUB checks cover anchors, script neutralization, reader routing,
vault import and chapter extraction with a generated fixture book. Clipping checks cover
extraction from generated pages (including a synthetic X thread), the worker's prompts and
bounds, and `vault/clip/save` with `reading_vault`. Browser tests launch headless Chromium and use local fixtures.
They do not authenticate or call a real model. `CHROME_PATH` can override the
headless binary too.

JavaScript/HTML/CSS/JSON/Markdown use Prettier. Python uses Black and four-space indentation.
To format Python, use a development virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m black extension/native extension/tests scripts
```

`npm run check` validates Python syntax without creating bytecode files.

### Troubleshooting: extension test launch timeout on macOS

Rarely, on a busy Mac, a test that loads an extension fails with
`browserType.launchPersistentContext: Timeout 180000ms exceeded.` after
`<launched> pid=...`. These tests launch the full Chrome for Testing app
(`channel: 'chromium'` with `--load-extension`): `store-setup.cjs`,
`resource-download.cjs` and `pdf.cjs` in `npm test`, and the optional
`npm run test:browser`, `test:highlights` and `test:epub` runners. macOS can
occasionally deadlock that app's main thread at startup inside RunningBoard
(`rbs_acquire_appnap_assertion`), usually when several Chrome instances start at
once. A healthy launch takes a few seconds, so this is not a slow machine and a
longer timeout does not help. Rerun the test. RunningBoard exists only on macOS,
so Linux CI cannot hit this.

## Optional integration checks

These are deliberately excluded from `npm test`:

| Check                                        | Prerequisites and effects                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `python3 extension/tests/native-smoke.py`    | Installed Codex; isolated signed-out app-server tests.                                       |
| `python3 extension/tests/native-install.py`  | Installed Codex; installation discovery and signed-out recovery.                             |
| `python3 extension/tests/session-storage.py` | Installed Codex with project APIs; isolated shared-home semantics.                           |
| `python3 extension/tests/oauth-preauth.py`   | Installed Codex and network; starts and cancels real OAuth flows without completing sign-in. |
| `node extension/tests/browser-input.cjs`     | Loaded extension in a dedicated debug browser; manipulates local fixture pages.              |
| `npm run test:highlights`                    | Playwright Chromium; source connector with temporary profile, HOME, and CODEX_HOME.          |
| `npm run test:pdf-highlights`                | Same isolation, fixture app-server for Codex; PDF.js highlights, saved turns, and restore.   |
| `npm run test:epub`                          | Playwright Chromium and Python; the real connector with temporary `HOME` and `CODEX_HOME`.   |
| `npm run test:library`                       | Same isolation, fixture app-server for Codex; library, local PDF import, reopen and restore. |
| `npm run test:clip`                          | Same isolation, fixture app-server for Codex; clipping pages into the vault.                 |
| `npm run test:local-files`                   | Same isolation, fixture app-server for Codex; files opened from the computer (`file://`).    |
| `npm run test:agent-tab`                     | Same isolation, fixture app-server for Codex; an Agent tab after its source page closes.     |

`npm run test:epub` imports a generated book into a temporary vault, checks highlights,
Ask AI, reopening, a browser restart and blocked book scripts. Codex discovery is
disabled, so no app-server or account is used.

`npm run test:library` seeds a webpage and an online PDF into a temporary vault, imports a
generated PDF and EPUB from the library, highlights and asks about the PDF (saving a turn
from the fixture app-server), opens the library from the side panel, opens every kind of
document from it, restarts the browser and checks drag and drop.

`npm run test:clip` highlights a generated article and clips it from the side panel. It checks
`article.md`, `article.html`, `article.json` and the saved image in the page's folder, that a
forbidden and an SVG image stay linked, that the page is not changed and only its images are
fetched, that `reading_vault` finds the text and that a question about
the page names `article.md`. It then clips again (the page asks first and an edited
`article.md` is kept), opens the clipped copy in the reader (the page's highlight painted, the saved image shown,
the others linked), highlights and asks Codex there and sees the highlight on the live page,
checks that the reader refuses a changed `article.html` and cleans forged markup without
running scripts or loading anything, clips a page that enforces Trusted Types, saves a short
page whole, checks that a highlight in another tab saves within two seconds while a clip saves
about 18 MB of images, then stops the server, restarts the browser, opens the clipped copy
from the library offline and deletes it.
Every request outside `127.0.0.1` is refused.

Clipping real sites cannot be tested offline. After updating Defuddle, clip by hand, in a
signed-in browser: a single X post, a thread, a long post and an X article; a post with images
and a video; a WeChat article; a Substack post; and a technical blog post with code. Check the
text, the image addresses and the thread's posts in `article.md`.

`npm run test:local-files` generates a PDF, Markdown, text and HTML files in the temporary
folder and opens them by `file://` URL. It checks that a PDF goes straight to the PDF.js
viewer, its highlight, Ask AI, note and vault copy under `urn:sha256`, a restart, a moved
copy and a library import of the same file, highlights and Ask AI on Markdown and text
files, the library entry of a text file, links from a local page and refused links from a
website, Agent tabs that keep asking and saving after a local file or reloaded PDF closes, and
the explanation page, side panel reminder and pick-up of open files when file
access is turned off and on. Codex is `fixtures/app-server-tools.py`, which wraps the
fixture app-server: a message line `TOOL {json}` makes it call the browser tool with those
arguments and record the result, which checks that Agent reads local tabs, cannot click or
type there and cannot open `file://` URLs. The file access part uses a copy of the
extension without its manifest key in its own profile: Chromium keeps file access for a
keyed extension loaded with `--load-extension` after the setting is turned off.

`npm run test:agent-tab` opens a highlight discussion on a local webpage and on an imported
PDF, expands each into an Agent tab and closes the page. The Agent tab must keep asking,
reloading, steering and stopping without disconnecting, save its turns to the same highlight
and thread, read the PDF's page files through `reading_vault`, report a browser read of the
closed page as a tool error, keep page history, and close the session with its last tab. The
fixture app-server follows `[hold]`, `[browser-read]` and `[vault-read:NNN]` in the message.

Start a debug browser with:

```sh
CHROME_DEBUG_PORT=9341 npm run dev
```

Tests default to `http://127.0.0.1:9341`; override it with `CHROME_CDP`. Close any
existing development instance for that profile before changing its launch flags.
Never point integration tests at a personal browser with important tabs or drafts.

## Packaging

```sh
npm run package
```

The result is `dist/Tabgent-macOS.zip`. Packaging includes the
extension runtime, Python connector, installation entry point, documentation,
and licenses. It also includes the development scripts and tests so the archive can be inspected
and developed independently. Dependencies, local profiles, credentials, and caches are excluded. No signing, publishing, or Git commit is performed.

### Manual conversation regression

Click the toolbar icon twice: the sidebar must show and hide without a menu.
Open the conversation in a new Agent tab. Check that messages, drafts, attachments
and approvals synchronize with the original sidebar and the original page remains
the default context. The new Agent tab must not show another expand button.
Its own sidebar must have an independent thread. Close either view and verify
the remaining view keeps its conversation. With the original page closed, the Agent
tab must keep answering, steering and stopping, show the page as closed, and keep
saving a highlight discussion to that highlight. Test the Agent + button creates an
empty Agent tab with the same original page, model, effort and scope, but no shared
history, draft or attachments.
Do not replace Chrome's native new-tab page or inject an Agent overlay into websites.
The reading toolbar and highlight popover are the only webpage UI.

## Isolated browser input tests

Run `npm run test:browser` to exercise real Chrome input against local fixtures:
trusted clicks and typing, shadow DOM, cross-origin frames, dragging, screenshots,
and history navigation. The runner uses a temporary profile and a minimal test
extension with no native messaging, so it cannot access your Codex account. Both
are removed after the run. It requires the Playwright Chromium browser.
