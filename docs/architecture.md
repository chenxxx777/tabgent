# Architecture

```mermaid
flowchart LR
  UI[Sidebar] <-->|Runtime ports| BG[Extension service worker]
  BG <-->|Scoped browser tools| Tabs[Chrome tabs]
  BG <-->|Native messaging| Host[Python connector]
  Host <-->|JSON RPC over stdio| Codex[Codex app-server]
```

## Source map

| Path                              | Responsibility                                                              |
| --------------------------------- | --------------------------------------------------------------------------- |
| `extension/background.js`         | Tab/session ownership, native transport, selection routing.                 |
| `extension/bridge.js`             | Runtime port connecting a chat view to its owner tab.                       |
| `extension/browser-tools.js`      | Scope enforcement, browser actions, page reading and frame context.         |
| `extension/browser-input.js`      | CDP-based trusted input and coordinate actions.                             |
| `extension/selection-content.js`  | Selected text, DOM endpoints, offsets, and frame-relative geometry.         |
| `extension/highlight-content.js`  | Selection toolbar, saved webpage highlights, and highlight actions.         |
| `extension/highlight-note.js`     | Note preview and editor shared by the webpage and PDF.js reading layers.    |
| `extension/web-anchor.js`         | Normalized page text, web anchors, and verified anchor restoration.         |
| `extension/vault-client.js`       | Reading-vault requests over the native port, with ids and timeouts.         |
| `extension/pdf/viewer.js`         | PDF.js wrapper: loading, fallback, live quotes, and Agent PDF commands.     |
| `extension/pdf/pdf-highlights.js` | Selection toolbar, saved PDF highlights, and highlight actions in PDF.js.   |
| `extension/pdf/pdf-anchor.js`     | PDF page text, PDF anchors, and verified anchor restoration.                |
| `extension/pdf/file.html`         | The PDF.js viewer's entry page for PDFs opened from the computer.           |
| `extension/local-files.js`        | `file://` URL checks, the file access prompt, files open before access.     |
| `extension/local-pdf.js`          | Hands a local PDF in Chrome's own viewer to the PDF.js viewer.              |
| `extension/file-access.html`      | Explains Chrome's "Allow access to file URLs" setting, opened once.         |
| `extension/epub/`                 | Library and EPUB reader page: vault documents, imports, books, highlights.  |
| `extension/epub-routing.js`       | EPUB reader port registry and sender checks.                                |
| `extension/clipper.js`            | Clipping a page: injection, the replace prompt, bounds and the vault save.  |
| `extension/clip-images.js`        | A clip's images: download, type and size checks, uploads, Markdown links.   |
| `extension/clip/`                 | Clipping script injected on demand and the shared sanitizer settings.       |
| `extension/reading-companion.js`  | Highlight and page conversations: reading context and saved turns.          |
| `extension/reading.js`            | Reading context parts, turn records, and vault append parameters.           |
| `extension/session-config.js`     | Browser tool schema and agent instructions.                                 |
| `extension/ui/`                   | Chat rendering, composer, attachments, previews, approvals, and onboarding. |
| `extension/_locales/en/`          | English UI strings; i18n structure is retained.                             |
| `extension/native/host.py`        | App-server discovery, sessions, authentication events, and RPC transport.   |
| `extension/native/attachments.py` | Bounded uploads and text/PDF/DOCX reading.                                  |
| `extension/native/vault.py`       | ReadingVault highlights, discussions, and Markdown files.                   |
| `extension/native/epub_text.py`   | EPUB chapter text for the vault, using the standard library only.           |
| `extension/native/pdf_text.py`    | Imported PDF page text for the vault, read with macOS PDFKit.               |

Each webpage tab owns a session. Agent tabs share that session through runtime
ports and retain its original page context. The sidebar beside an Agent tab has
an independent session with the Agent tab as its context. The `agentViews` map
records ownership before the Agent page loads. Closing the source transfers
ownership to a remaining Agent tab; the native process closes with the final view.
The Agent tab keeps the closed page as its companion (`agentCompanions`): each
message names it with its last known address and `closed: true`, browser scope
follows the Agent tab's own window, and a browser action on the closed tab fails
with a tool error that says so. Sessions created in that view (Agent +, page
history, a highlight) belong to the Agent tab and start with what it knew of the page.
A prewarmed spare reduces startup work. Full Agent tabs hide the expand button.

Chrome owns the toolbar's sidebar toggle. The Agent + button creates an independent
Agent tab that inherits the source session's page and settings, without copying
conversation content. View-only sessions close when their final Agent tab closes.
There are no layout menus or persisted layout preferences. The only interface drawn
on websites is the reading layer described in [Webpage highlights](#webpage-highlights).

The service worker checks tool scope on every request. Selection messages derive
the owner tab and frame from Chrome's sender metadata, not a page-supplied tab ID.
Their URL comes from Chrome's frame record, because `sender.url` keeps the load-time
URL after `history.pushState`.
DOM locations are historical hints and must be checked against the live page.
Online PDF documents in top-level tabs are redirected to a bundled PDF.js viewer
using a response-header declarative rule. The source URL and Chrome tab ID remain
the conversation context. PDF.js runs locally with PDF JavaScript disabled. It
provides text-layer selections with page numbers/PDF coordinates, page reads,
exact text selection, highlights, and annotated PDF downloads. Highlights made with
Tabgent's selection toolbar are saved to the ReadingVault (see
[PDF highlights](#pdf-highlights)). The viewer's native annotation tools also support
manual highlights, comments and edits. Those PDF.js changes must be downloaded to
save a copy; they are not automatically persisted across reloads.

PDF viewer ports are validated by extension URL, tab, frame, and document ID;
Chrome hides extension documents from `webNavigation.getFrame`. Browser commands
are still checked against the selected tab/window scope. Vendor files and licenses
are in `extension/vendor/pdfjs`, with packaging details in its README.

A load failure or **Open in Chrome viewer** installs a tab/URL-specific session
allow rule before navigating back, preventing redirect loops. Other tabs continue
to use PDF.js. Embedded PDFs, POST responses and explicit attachment downloads are not
automatically redirected. PDFs opened from the computer have their own rule and entry page
(see [Files from the computer](#files-from-the-computer)). Existing open PDFs use the new
viewer after reload unless that tab/URL has opted into native fallback.

The native fallback is retained: **Quote in Agent** sends a right-click quote
without reliable page coordinates. For HTTP(S) PDF tabs, `browser read` fetches
the original bytes in Chrome and sends them to PDFKit in the native host. These
reads are limited to 10 MB and temporary files are deleted. Screenshot, pointer,
keyboard, and scroll tools operate the native viewer directly. Neither text
reading path implements OCR for scanned pages.

## ReadingVault

The connector keeps reading highlights and discussions in a local Markdown folder,
`~/ReadingVault` by default. The extension sends `{ op: "vault", id, method, params }`
on the existing native port and receives `{ op: "vault", id, result }` or
`{ op: "vault", id, error: { code, message } }`. Vault requests run on their own
single-worker queue in arrival order. They never use `warm` settings, sessions, or
the Codex app-server, so highlights save while Codex is offline or signed out.

`vault/configure` stores a chosen folder in `$CODEX_HOME/projects/tabgent/vault.json`;
otherwise the default folder is created on the first write. Each write scaffolds
`AGENTS.md` (layout, `rg` retrieval hints, and reading rules for Codex), `Articles/`,
and `Books/`. Web pages live in `Articles/article-<title slug>-<URL hash>/`, PDF
documents in `Books/paper-<title slug>-<URL hash>/`, and EPUB books in `Books/` (see [EPUB reader](#epub-reader)). A PDF imported from the computer is a `paper-*` document
named `urn:sha256:<hex>` (see [Library and local PDFs](#library-and-local-pdfs)). URLs are
matched without their fragment, as in page history, through `.tabgent/index.json`, which
is rebuilt from the folders if missing. `vault/documents/list` lists every document. A
clipped webpage also has `article.md`, `article.html` and `article.json` in its folder (see
[Web clips](#web-clips)).

`anchors.json` is the machine record: anchors, highlight IDs (`h001`, never reused),
the user's notes on highlights, and discussion turns, which are idempotent on thread
and turn ID. `highlights.md` is the readable record with YAML front matter, one
`## Highlight NNN` section per highlight, and a `## 文档对话` section for
document-level discussion. HTML comment markers delimit Tabgent's blocks. After a file
exists, Tabgent only inserts into or removes those blocks, so edits elsewhere are
preserved; a deleted highlight removes its whole block. Missing blocks or files are
restored from `anchors.json` on the next write to them. Unreadable JSON or non-UTF-8
Markdown is reported, never replaced.

`vault/highlight/update` (`{ documentId, highlightId, note }`) sets the user's own note
on a highlight. The note is trimmed, limited to 20,000 characters, and stored on the
highlight in `anchors.json`; every highlight result carries it as `note` (empty when
there is none). In `highlights.md` it is a `### 笔记` part inside the highlight's block,
between the quote and `### 对话`, delimited by `<!-- tabgent:note hNNN start/end -->`.
An update replaces only that part, so text the user wrote elsewhere in the block stays;
an empty note removes the part, and an unchanged note writes nothing. Markdown is
written before `anchors.json`, so a retried update repeats the same edit. A deleted
highlight takes its note with it, and a deleted or unknown highlight returns
`not_found`. As with turns, `anchors.json` is the source: editing the note text inside
its marked part in `highlights.md` does not change the saved note, and the next update
from Tabgent replaces it.

Writes hold a process lock plus an advisory lock on `.tabgent/lock`, and replace
files through a temporary file and rename, so concurrent requests and a second
connector process cannot interleave. Error codes are `invalid_params`, `not_found`,
`vault_unwritable`, `io_error`, `unknown_method`, and `internal_error`.

## Webpage highlights

Top-level HTTP(S) pages, and text files opened from the computer (see
[Files from the computer](#files-from-the-computer)), load `web-anchor.js` and
`highlight-content.js`. A non-empty
selection shows a small toolbar with **Highlight** and **Ask AI**. The toolbar and the
highlight popover live in one closed shadow root on a top-layer `popover` host. Inline
`!important` host styles and constructed stylesheets keep page CSS out and do not
need the page's `style-src`. Pressing Tab while the toolbar is visible moves focus
into it. Arrow keys move between actions, and Escape returns to the selection. Scrolling,
resizing, collapsing the selection, or pressing Escape dismisses it.

Highlights are painted with the CSS Custom Highlight API (`highlight.css`), so page
markup is never wrapped or rewritten. Custom highlights receive no events. A click
is hit-tested with `caretPositionFromPoint` and confirmed against the range's line
boxes, then opens **Ask AI** (or **Open discussion** when turns exist), **Add note**
(or **Edit note**) and **Delete**, with the user's note shown above them.
Clicks on links and controls are left to the page. Pages can read the highlight
registry, so a site can observe which of its passages are highlighted.

A web anchor follows the shared vault contract. It stores the quote with 32
characters of prefix and suffix, offsets into the page's normalized text, and a
DOM path hint. Normalized text joins light-DOM text nodes and collapses whitespace
and block boundaries into one space. Script and style text, soft hyphens, and
zero-width characters are dropped. Restoration tries the DOM hint, then the stored
position, and accepts either only when the quote and its full context match. Otherwise
every occurrence of the quote is scored by context. Identical passages are decided by
position only when one is clearly closer. A near-identical edited quote is accepted
only between its old context. Anything less certain stays unanchored: it keeps its
vault record, is never drawn on other text, and is reported to the tab's conversation
as `codex-highlight-status`. Late or replaced content triggers re-anchoring from a
mutation observer, throttled by the cost of the previous pass. SPA navigation reloads
the page's highlights.

The service worker accepts highlight messages only from the top frame of the
sender's current document. Vault URLs come from Chrome's frame record without the
fragment, because `sender.url` keeps the load-time URL after `history.pushState`.
`vault-client.js` sends `op: "vault"` requests over the existing connector port,
with request IDs, timeouts, and rejection on disconnect. Vault operations do not
claim or wait for a Codex session; opening the port still sends its usual prewarm
request. Delete and Ask AI on saved highlights are checked against the vault record
for the sender's URL.

**Ask AI** saves the highlight, then reuses the page-selection quote flow. The quote
carries `highlight: { documentId, highlightId }` and nearby text in
`context: { before, after }`. If saving fails, the quote is still sent without a
highlight. `chrome.sidePanel.open()` is called synchronously in the runtime message
listener. In Chrome 151, a content-script click allows the call only before the
listener's first await: a microtask, an extension API await, or a timer loses the
gesture. When the panel cannot open, the page asks the user to click the toolbar
button; the quote is already waiting in the conversation.

**Add note** opens a small editor from `highlight-note.js` in the same shadow root,
at the highlight. Focus moves to its text field and stays inside the editor (Tab
cycles through the field, Cancel and Save); Cmd/Ctrl+Enter saves, Escape cancels, and
neither acts during an input method's composition. Keys typed there stop at the
editor, so page shortcuts never see them. A click elsewhere closes an unchanged editor
and keeps one with unsaved text. Saving sends `highlightNote`; the service worker
checks the highlight against the vault record for the sender's URL, calls
`vault/highlight/update`, and tells the tab's side panels to refresh their list.

Highlights cover the top frame's light DOM. Iframes and shadow DOM are not drawn; PDFs
and EPUB books have their own reading layers, described next. Tabs opened before the extension was installed or reloaded
need a reload to show highlights.

## PDF highlights

The bundled PDF.js viewer has the same reading layer as webpages. `pdf-highlights.js`
runs in the viewer page and works inside the PDF.js frame. A text selection shows
**Highlight** and **Ask AI**; a click on a saved highlight shows the user's note,
**Ask AI** (or **Open discussion**), **Add note** (or **Edit note**) and **Delete**.
The note editor is the webpage one; it stops the keys typed into it, so PDF.js
shortcuts (such as `n` for the next page) do not fire. Strings, colors, keyboard behavior, and vault
messages are the webpage ones. `highlight.css` is linked, because the PDF.js page CSP
(`style-src 'self'`) blocks inline styles. The PDF.js floating highlight button is
turned off so there is one **Highlight** action; the PDF.js highlight tool still adds
annotations for `savePdf`.

Highlights are painted with the CSS Custom Highlight API on PDF.js text layers. They
are repainted when PDF.js renders a text layer again or splits it for find-bar
matches. The PDF bytes and the PDF.js annotation storage are never changed:
annotated downloads contain only PDF.js edits, and a saved highlight does not make
the native-viewer fallback warn about unsaved changes.

A page's text is its text-layer text, normalized like webpage text: whitespace runs
and line ends become one space. The text layer and
`getTextContent({ includeMarkedContent: true, disableNormalization: true })` give the
same text, so pages that are not rendered can still be searched. A PDF anchor is:

```text
{ kind: "pdf", page, endPage?, quote: { exact, prefix, suffix },
  textLayer: { start, end }, rects: [{ page, pdf: [x1, y1, x2, y2] }] }
```

`page` is one-based. `endPage` is present when a highlight crosses a page break; the
quote then joins the pages' text with one space, and `textLayer` offsets index that
joined text. `rects` are PDF user-space points merged per line. They are kept for
reference and are not used to restore. The location label is the localized page,
such as `p. 12` or `pp. 12–13`.

Restoration accepts the saved offsets on the saved page only when the quote and its
full context match. Next, the saved page is searched for the quote with the webpage
scoring (`matchQuote` in `web-anchor.js`). Only if that fails is the whole document
searched, which finds text that moved to another page, for example in a revised PDF at
the same URL. Identical passages are decided only when one is clearly closer to the
saved position. Anything less certain stays unanchored and unpainted, and is reported
as `codex-highlight-status`.

The vault document is the original PDF URL without its fragment, or `urn:sha256:<hex>`
for an imported PDF. Its title is the PDF metadata title, chosen as PDF.js does
(`pdf-info.js`), or the file name; `meta` carries the PDF author
and the host name. The service worker accepts PDF highlight messages only from the
current viewer document of the tab, the same check as PDF selections, and sends
`kind: "pdf"` with an anchor reshaped by `cleanPdfAnchor`. Like the webpage layer, the
viewer answers `tabgentHighlight` messages from the service worker in its top frame:
`context` returns a highlight's nearby text, `jump` scrolls its page into view and
marks it briefly, and `refresh` reloads the saved highlights (for example after a
saved turn) while keeping restored ones in place.

**Ask AI** follows the same gesture rule as webpages. The quote carries
`highlight: { documentId, highlightId, kind: "pdf" }`, the page label as `location`,
`context` with up to 1500 characters before and after (including the previous and
next page, whose text is loaded in advance so the click never waits), and
`locator: { kind: "pdf", anchor, page }`. It binds the conversation like a webpage
quote (see Reading conversations). A question without a highlight saves to the PDF's
document, because the worker maps the viewer tab to the original PDF URL with
`kind: "pdf"`. Codex reads PDFs one page at a time with
`browser read` (`page` and `offset`; the result includes the page count), so a long
PDF is never sent whole.

The native fallback viewer has no highlights. Scanned pages without a text layer
cannot be highlighted, and page labels use physical page numbers, not printed ones.

## EPUB reader

The bundled reader is an extension page, `epub/reader.html`, whose start screen is the
[library](#library-and-local-pdfs). It renders books with foliate-js
(`extension/vendor/foliate-js`) in paginated or scrolled mode, with a table of contents,
font size, and the reading position stored in `chrome.storage.local`. A book is opened
by choosing or dropping a file, or from the library.

A book's identity is the SHA-256 of its file: the vault URL is `urn:sha256:<hex>`, so a
re-picked file or the vault copy maps to the same `Books/book-<title slug>-<hash>/`
document, and another edition is another book. On first open the reader uploads the
file with `vault/source/save` in 2 MiB base64 chunks. The host appends them to
`.tabgent/uploads/<sha256>.part`, so an interrupted import resumes, verifies the hash,
and moves the file to `original.epub` with a `source.json` record. Originals are limited
to 100 MiB and never replaced. The tab URL then becomes `reader.html?book=<document ID>`,
which reopens the book through `vault/source/read` (checked against the recorded hash)
and names it in page history and message context. `vault/books/list` lists books whose
original is stored.

At import, `epub_text.py` writes each spine document with text to
`chapters/NN-<title>.md`, with front matter naming the book, chapter and EPUB path. Titles
come from the navigation document or NCX, then the first heading. The archive is read
in memory with entry and total size limits, XML entity declarations are rejected, and
missing chapter files are regenerated from the original. `AGENTS.md` tells Codex to read
or search these files instead of the whole book.

Books cannot run scripts. Script resources are not loaded, `<script>` elements get an
inert type (so CFIs are unchanged), and event attributes, `srcdoc` and `javascript:` URLs
are removed before a chapter renders. The reader's own CSP, inherited by foliate's
`blob:` chapter frames, allows only the extension's scripts and blocks remote images,
fonts, styles and frames. The frames' sandbox allows no forms, popups or top navigation, and HTTP(S)
links open in a new tab.

An EPUB anchor is `{ kind: "epub", cfi, quote: { exact, prefix, suffix }, chapter:
{ href, title, index }, position }`. The quote, 32-character context and offsets use the
chapter's normalized text from `web-anchor.js`, and the highlight location is the
chapter title. A CFI is accepted only when it resolves to the quote with the same
context. Otherwise the quote is searched within that chapter with the webpage matcher.
Uncertain records are listed as not found in the reader's Highlights tab, never painted,
and reported as `codex-highlight-status`. Highlights are drawn by foliate's overlayer;
clicking one shows the user's note and offers **Ask AI** (or **Open discussion**),
**Add note** (or **Edit note**) and **Delete**. The note editor is part of the reader
page, with the same keys as on webpages, and saves through `epubHighlightNote`. The
Highlights tab shows each note under its quote. A `refresh` command on the reader port
reloads the highlight records (notes and turn counts) after a note is saved from the
side panel or a turn is saved.

The reader calls `chrome.sidePanel.open()` synchronously in the click, then asks the
service worker to save and hand off the selection through `handOffSelection()` and
`reading.focusHighlight()`, so each highlight has its own conversation as on webpages.
The quote's `url` is the book's `urn:sha256:` identity, and it carries
`highlight: { documentId, highlightId, kind: "epub" }`, the chapter title as `location`,
chapter text in `context: { before, after }`, and
`locator: { kind: "epub", anchor, documentId, chapterFile }`. `chapterFile` is the
absolute path of the chapter's Markdown file. Plain selections use the page selection
flow with an EPUB locator.

Each reader document registers an `epub` port, and the service worker accepts messages
only from a tab's current reader document. The port also names the open book, so
`pageDocument()` maps a reader tab to `{ url: "urn:sha256:…", kind: "epub" }` for
page-level saving, and it carries the side panel's highlight commands (jump, nearby
text) that webpages answer from their content script. The reading context of a
message about a book names its `chapters` folder.

The reader is not a browser tool target: the instructions tell Codex to read chapter
files through `reading_vault` instead.
Fixed-layout books use foliate's fixed-layout renderer, which has no overlay layer, so
their highlights are saved but not drawn (their notes are kept and listed). Book search
and EPUB files opened from websites or `file://` URLs are not supported.

## Library and local PDFs

The library is the start screen of `epub/reader.html`. It opens from the toolbar
button's context menu and from **Open library** in the side panel's Reading notes menu,
which opens it in a tab next to the page. It lists every vault document with
`vault/documents/list`, most recently updated first: title, kind (webpage, PDF, imported
PDF or EPUB), author or host, highlight count and the last update. Each entry is a link:

| Document     | Opens                                                        |
| ------------ | ------------------------------------------------------------ |
| Webpage      | Its HTTP(S) URL; the page restores its highlights.           |
| Local file   | Its `file://` URL, opened with the tabs API.                 |
| PDF (web)    | `pdf/viewer.html?url=<PDF URL>`, the bundled PDF.js viewer.  |
| Imported PDF | `pdf/viewer.html?url=urn:sha256:<hex>`, from the vault copy. |
| EPUB         | `reader.html?book=<document ID>`, from the vault copy.       |

Entries whose original is not in the vault (an EPUB that was never imported, or a removed
file) are listed but not openable. Other URL schemes from the vault are never opened.

Choosing or dropping a file accepts EPUB books (handled as in [EPUB reader](#epub-reader))
and PDFs, recognized by their first bytes. A PDF is limited to 100 MiB, the vault's
limit for originals. The library reads its title and author with PDF.js, as the viewer
does, which also refuses a damaged file before it is copied; an encrypted PDF is named by
its file. Its identity is the SHA-256 of its bytes: `vault/source/save` stores it with
`kind: "pdf"` and the URL `urn:sha256:<hex>` in the same 2 MiB chunks, resumable uploads
and checks as an EPUB, as `Books/paper-<title slug>-<hash>/original.pdf` with
`source.json`. The vault refuses a `urn:sha256:` URL that is not the file's hash. The same
file always maps to the same document, so dropping it again opens its existing copy.
After the import the tab opens the viewer for that identity.

At import, `pdf_text.py` reads every page's text with macOS PDFKit in one `osascript`
process (as the PDF fallback reader does for one page) and the vault writes
`pages/NNN.md` for each page with text, with front matter naming the paper and page.
Text is bounded per page and per document; pages without text (scanned pages) get no
file, and a PDF without any text, an encrypted one, or one PDFKit cannot read is recorded
in `source.json` (`pageError`) and still opens. Missing page files are regenerated when
the file is imported again. `reading_vault` searches and reads them like EPUB chapters,
and the reading context of a message about an imported PDF names its `pages` folder, so
Codex can read the paper while its viewer tab is closed.

A PDF opened from the web and an imported copy of the same file stay separate documents
with separate notes. The web identity is the address, which can serve a revised file
later (see [PDF highlights](#pdf-highlights)), while the imported identity is the bytes;
Tabgent does not keep a hash of the online file, so it cannot tell that they are the
same, and merging would rewrite notes the user may have edited. The library lists both.

`pdfSource()` accepts `urn:sha256:<64 lowercase hex>` as a PDF source, so the viewer
tab is a PDF tab everywhere: highlights, Ask AI, plain selections, page history, the
per-message browser context, `pageDocument()` for page notes, and `browser read`. The
viewer of an imported PDF reads the vault copy with `pdfLocalRead` messages. The service
worker accepts them only from the tab's current top-frame viewer whose `pdf` port is
registered, resolves the document from the viewer's own address (never from the page's
request), and relays `vault/source/read`. The viewer checks the bytes against the hash
in its address and opens them with `PDFViewerApplication.open({ data })`. There is no
web address, so **Open in Chrome viewer** is hidden and `pdfFallback` is refused. An
imported PDF is not in the vault any more when the vault folder is changed; the viewer
then reports that it cannot be opened.

## Web clips

**Clip this page** (the toolbar button's and the page's context menus, the `clip-page`
command, Alt+Shift+S by default, and the side panel's Reading notes menu) saves a webpage's
main text into the page's own vault document. The page and its clip are one document named
by the URL, as for highlights, so highlights, notes and discussions belong to both.

`clipper.js` runs in the service worker. It takes the tab's top-frame URL and document from
`webNavigation.getFrame`, refuses anything but HTTP(S) pages outside incognito, and injects
`vendor/defuddle/defuddle.js`, `vendor/turndown/turndown.js`, the UMD build of DOMPurify,
`clip/sanitize-config.js` and `clip/clip-content.js` into frame 0 with
`chrome.scripting.executeScript`. Nothing is loaded into pages that are not clipped. Each
later call checks that the injection result's `documentId` is still the frame's, so a page
that navigated mid-clip saves nothing. A single-page app can change its address without a
new document, so the worker also reads the frame again after each prompt and the clipping
script compares `location` with the address it was asked to clip; a page that moved stops
the clip and says so, and a prompt closes when the page's address changes. If the document
already has a clip, the page shows a prompt (a closed shadow root on a top-layer popover,
like the reading toolbar) and only **Replace** continues. **Clip selected text** from the
side panel checks that the page still selects the quote attached in the conversation. An
address whose vault document is a PDF (Chrome's own viewer) is refused.

`clip-content.js` runs Defuddle's synchronous `parse()` with `useAsync: false` and a
`fetch` that always rejects, so no extractor contacts a third party. Defuddle normalizes
some attributes of the document it is given, so it reads `document.cloneNode(true)`:
elements that `checkVisibility()` reports as not displayed are marked `hidden` in the copy,
and images keep their displayed size, so the page the user reads is never modified. On
`x.com` and `twitter.com`, single posts use Defuddle's X extractor with
`includeReplies: false` (the post and the author's thread loaded on the page); X articles
use its article extractor; timelines and profiles are refused. The result is parsed into an
inert `DOMParser` document. Images keep only their address in `data-remote-src` (the best
`srcset` candidate up to 2048 pixels, `pbs.twimg.com` at `name=large`; tracking pixels and
`data:` images are dropped), frames and media become links, links become absolute HTTP(S)
or mail addresses or in-page fragments, and DOMPurify then removes everything else with the
allowlist in `sanitize-config.js` (no scripts, styles, `style` or `class` attributes, forms,
frames, SVG or media). Turndown converts the cleaned HTML with Tabgent's rules for images,
fenced code with its language, strikethrough, MathML with LaTeX, and GFM tables (tables with
merged cells become lines of text). The HTML is cut at a block boundary to 4 MiB and the
Markdown at a paragraph break (else a line break, never inside a surrogate pair) to 3 MiB
(UTF-8); a code fence the cut left open is closed, and each ends with a note. When little text
is found, the page offers **Save whole page** (Defuddle on `body` without low-score
removal) or, with a selection, the selected text only.

The worker treats the result as untrusted: `cleanClip` refuses oversized or empty text and
bounds every field before `vault/clip/save`. The vault writes `article.html` (the cleaned
HTML in a page whose policy, `default-src 'none'`, blocks scripts and remote loads if the
file is opened directly), then `article.md` (front matter with `source`, `clipped` and the
page metadata, then the text), and last `article.json`, the record naming both files with
their SHA-256 and size. A clip is complete when the files have the recorded sizes. A
document with a clip conflicts unless the request says `replace` and `expected` still
names its `clippedAt`, so two tabs cannot overwrite each other silently. An `article.md`
whose hash differs from the record (edited by the user) is renamed to
`article-edited-<time>.md` before it is replaced. All extraction happens in the browser;
under the vault lock the connector only writes and renames files. `vault/document/resolve`
and `vault/documents/list` report the clip, the side panel offers **Clip this page again**,
and the reading context of any message about the page names its `article.md`.

Images are saved by the worker (`clip-images.js`), not the page. The clipping script writes
each image in the Markdown as a placeholder named by a random per-clip token, which the page
cannot read from the isolated world. The worker fetches each distinct address once with its
host access (no CORS), `referrerPolicy: 'no-referrer'`, and cookies only for the page's own
site and only on the first request (a same-site image is fetched with `redirect: 'manual'`,
and a redirect is followed again without cookies; the site test is an approximation without
the Public Suffix List), four at a time within 15 seconds each and 45 seconds overall. It keeps JPEG, PNG, GIF,
WebP and AVIF by their first bytes (never by `Content-Type`; SVG is not saved), up to 50
images, 5 MiB each and 30 MiB together, one file per SHA-256. Each image is uploaded with
`vault/clip/asset` in 2 MiB chunks, one request at a time, so other vault requests wait for
at most one chunk; the upload is staged in `.tabgent/uploads/asset-<sha256>.ready` after its
hash is checked. Placeholders then become `assets/<first 16 hex digits>.<ext>`, or the web
address for images that were not saved. `vault/clip/save` refuses (`missing_asset`) a clip
whose images are neither staged nor already in the folder before it writes anything, copies
staged images into `assets/` (refusing a linked `assets` folder; the staged copy stays for
other clips that share the image and is pruned after a day), records each image's file,
hash, type and source in `article.json`, and removes images the previous clip recorded that
the new one does not use, unless a kept `article-edited-*.md` still links them;
other files in `assets/` are kept. Images the size limits cut away are not downloaded, and if
web addresses would make the Markdown too long, unsaved images keep only their description. Failed images are listed with
the reason. `article.html` keeps every image's address in `data-remote-src`; the reader maps
addresses to saved files through `article.json`.

Clipping covers the top frame's light DOM, not frames or shadow DOM.

## Files from the computer

Tabgent works on files the user opens in Chrome from the computer, typically by
double-clicking a PDF, Markdown, text or HTML file whose default application is Chrome.
Nothing is imported first. A `file://` URL is a document only when it names a file: a
directory listing (its URL ends in `/`) and a URL with a host are never documents, readable
tabs, or senders.

**File access.** The manifest requests `file:///*`, and Chrome grants it only after the user
turns on **Allow access to file URLs** on Tabgent's page in `chrome://extensions`; the
extension cannot turn it on. `chrome.extension.isAllowedFileSchemeAccess()` reports it.
Without it, Chrome injects no content scripts into `file://` pages, applies no
declarative rules to them and refuses scripting, but webNavigation events still report the
URLs. The first committed top-level navigation to a readable type (`.pdf`, `.md`,
`.markdown`, `.txt`, `.html` and similar) while access is off opens `file-access.html`
once, next to the file (`fileAccessPrompted` in `chrome.storage.local`). It explains the
setting and opens `chrome://extensions/?id=<extension ID>`. The side panel's context
reports `fileAccess: false` for a local companion tab, which shows a reminder with the
same button. Changing the setting reloads the extension. The worker stores the last known
state (`fileAccess`); when it changes from off to on, local tabs get `local-pdf.js`, the
selection script, the reading layer and its stylesheet, so open files work without a reload.

**Markdown, text and HTML files.** The manifest declares the selection script (top frame
only) and the reading layer for `file:///*`, excluding URLs that end in `/`. The reading
layer runs only when Chrome shows a text document (`text/*`, XHTML, XML or JSON), so a PDF,
image or media file gets none. Highlights, Ask AI, notes and page conversations work as on
webpages: the worker accepts `file://` senders from the top frame of the current document,
checked against Chrome's frame record like HTTP(S) senders, and accepts no `file://`
subframe, because a local page can load other local files into frames. The vault document
is the `file://` URL without its fragment, kind `web`, in `Articles/`. A text file is
edited in place, so a content hash would orphan its notes after every edit; the path keeps
them, and the web anchors re-find passages after edits. Moving or renaming the file leaves
its notes at the old path. Markdown is shown as Chrome shows it, as plain text.

**PDFs.** A second dynamic redirect rule (`900002`) matches main-frame `file://` URLs whose
path ends in `.pdf` (case-insensitive) and sends them to `pdf/file.html?url=<file URL>`.
Chrome applies it before its own viewer loads and records a server redirect, so the tab
shows no flash of Chrome's viewer and history has no `file://` entry. Chrome applies
extension rules only after the extension has loaded: a PDF that opens Chrome at launch
loads in Chrome's viewer first. `local-pdf.js`, declared for `file:///*` at
`document_start`, runs in Chrome's PDF document (`document.contentType` is
`application/pdf`) and asks the worker with `localPdfOpen`, which also covers PDFs whose
name does not end in `.pdf`. The worker answers with the viewer URL unless a session rule
records that the user chose Chrome's viewer for that tab and URL, and the script replaces
the location, without a history entry. `chrome.runtime.onStartup` injects the script into
local tabs that loaded before the extension.

`file.html` is `viewer.html` under another name. It is web accessible only to `file://`
pages, so a link in a local HTML file can open a local PDF in it, while a website cannot
navigate to it; `viewer.html` (web accessible to HTTP(S) pages) never accepts a `file://`
source. The viewer refuses a `file://` source in a frame. It reads the file with `fetch()`,
which Chrome allows extension pages while file access is on, through the same browser
process that loaded the `file://` URL. It then computes the SHA-256 of the bytes, opens a
copy of them in PDF.js, and sends `{ type: "document", sha256 }` on its `pdf` port, again
after every reconnect. The worker keeps the hash only for a `file.html` port in a tab's top
frame. **Open in Chrome viewer** adds the same tab-scoped session allow rule as for online
PDFs and navigates back to the `file://` URL.

The vault document of a local PDF is `urn:sha256:<hex>`, kind `pdf`, as for a PDF imported
in the library: the same file opened from anywhere, renamed, moved or imported shares one
document, and a changed file is a new one. Highlight and page-conversation messages from
the viewer resolve that URN from the hash its port announced (waiting briefly for it),
never from the page or its path. The quote of an Ask AI hand-off carries the URN, while the
per-message browser context names the `file://` URL, so Codex sees where the file is. As for
webpages, an Agent tab whose local page closes keeps the page's last `file://` address
and its document. A local PDF's remembered document also records the file's address
(`fileUrl`), so a reload of its viewer, which commits `file.html` again and names the file
only once it is read, keeps the document while the tab shows the same file.

The viewer copies the PDF into the vault once the document exists (its first highlight, or
when a saved page conversation or a reopened PDF finds the document), through
`pdfFileSave` messages relaying `vault/source/save` in the import's 2 MiB chunks. The worker
accepts them only from the tab's current `file.html` viewer and fills in `url` and
`sha256` from the announced hash; the vault checks the bytes. The copy is `original.pdf`
with `source.json` and the page text in `pages/`, exactly as an import, so the library
reopens it and Codex can read its pages after the file moves or the tab closes. Copying at
the first note, rather than on open, means opening PDFs to read them writes nothing, while
any PDF with notes keeps its source. A PDF larger than the 100 MiB vault limit keeps its
notes without a copy.

**Agent.** Local tabs are in the browser tool's scope like HTTP(S) tabs, listed by their
`file://` URL (a local PDF by its file, not the viewer). They are read-only: `read`,
`frames`, `screenshot`, `scroll`, `focus`, history navigation and the PDF.js commands work;
`click`, `hover`, `drag`, `type`, `press`, `select`, `check`, `resources` and
`saveResource` are refused, so Agent cannot follow a link in a local page to open another
file. `read` covers the top frame of a local page and never its `file://` frames.
`navigate`, `open` and conversation links accept only HTTP(S) URLs, so Agent never opens a
local file. Reading a local PDF left in Chrome's viewer fetches the file in the worker and
uses the PDFKit path of online PDFs.

## Reading conversations

`reading-companion.js` runs in the service worker and binds conversations to vault
documents and highlights. It lives there rather than in the side panel because the
worker receives every app-server notification for every session, whether or not a
view is open. The native host would add no durability: it and its Codex processes
exit when the worker's port closes, which also ends any running turn.

A quote that carries `highlight: { documentId, highlightId }` binds its conversation
to that highlight. Any reader can send it (web, PDF or EPUB, named by the highlight or
locator `kind`). Follow-ups keep the binding while the companion page shows the same
document. The worker remembers the document each companion tab last showed
(`pageDocuments`, forgotten when the tab navigates elsewhere; the EPUB reader keeps
its book while the tab stays in the reader, as on a reload), so after the page closes
its Agent tab still binds to it and saves there. **Ask AI** on a highlight with saved
turns reopens its latest thread through the page-history resume path, with the quote
attached again. A new highlight reuses an empty conversation and otherwise starts its
own, so each highlight's thread holds its discussion. The highlight list in the Page
conversations drawer does the same, and jumps to anchored highlights; unanchored ones
are marked and keep their notes. Each entry shows the user's note and edits it inline
(`readingNote`); the worker checks the highlight against the companion tab's document,
saves it, and asks the page or reader to refresh its highlight records. A draft
survives list refreshes.

The worker adds a hidden reading-context part after the browser context of each
message. It names the document (title, URL, kind and notes file), the bound
highlight (its text unless the quote is attached, and the user's note on it as
`userNote`, read fresh for each message and cut to 2,000 characters), up to five
earlier turns on it
from other threads (about 6,000 characters, sent once per thread), the vault folder
with its `AGENTS.md`, and the save target. The part is also the turn's durable
record: on `turn/completed` with status `completed`, the worker reads it back from
the turn's user message and calls `vault/discussion/append` with the user's own
words (quotes other than the highlight become a Markdown block quote) and the final
non-commentary answer. Appends are idempotent on thread and turn ID. Failures that
retrying can fix wait in `chrome.storage.local` (`readingOutbox`, at most 100) and
retry after the next successful save and on worker start.

Page-level questions save to the document's `## 文档对话` section only when the
conversation is set to save. **Reading notes** in the composer shows the target
(Highlight N, Page notes or Not saved). It defaults on for a highlight conversation
or when the page already has vault notes, and off otherwise, so unrelated
browser-automation chats are not written to the vault. Its menu also shows the vault
folder and changes it with `vault/configure`; existing notes are not moved.

For questions across documents, Codex searches the vault on demand. The read-only
sandbox already allows reading the vault folder, but in Ask for approval mode Codex
asks before every shell command, including `rg` and `cat`. The connector therefore
adds a `reading_vault` dynamic tool next to `read_attachment`. The host answers it
locally on the vault queue: `list` names the documents, `search` ranks lines of
`highlights.md`, `source.md` and clipped pages' `article.md` by matching keywords (the
user's notes first), optionally within one `document`.
A book's `chapters/*.md` and an imported PDF's `pages/*.md` are searched only when
`document` names that book or paper, and its notes still rank first, so their text never
crowds out the user's notes and a search never scans the whole library. `read` returns
numbered lines of the vault's `AGENTS.md`, a document's `highlights.md`, `source.md` or
`anchors.json`, a clipped page's `article.md` (only under `Articles/article-*`), an imported book's `chapters/NN-<title>.md`, or an imported PDF's
`pages/NNN.md` (only under `Books/book-*` and `Books/paper-*` respectively). The vault folder may be shared, for example
with Obsidian or the home folder, so no other file is readable. Each file must sit at
its exact place under `Articles/` or `Books/` with Tabgent's file names and no symlink
in between. The tool cannot write. Shell reads still work where the permission mode
allows them. The instructions in
`session-config.js` and the vault's `AGENTS.md` describe both.

## Working on the UI

Keep the bottom toolbar on one line. Long page titles truncate and open a details
popover on click. Selection drafts show two lines until expanded. Image attachments
use thumbnail-only chips and an original-image preview; ordinary file attachments
retain their filenames. All new user-facing strings belong in the English catalog.

## Boundaries

A Chrome extension cannot reproduce all browser chrome or desktop-app behaviors.
Side-panel opening requires a user gesture, and the call must happen before any
await; native menus and protected pages have separate restrictions. Keep these
limitations explicit rather than emulating a second browser or silently claiming
unsupported capabilities.

## Native Codex tools

The connector launches `codex app-server --stdio` using the user's existing
`CODEX_HOME`. It adds `browser` and `read_attachment` without disabling Codex's
native tools or overriding feature flags. Web search mode and configured
Apps/MCP integrations follow the user's Codex configuration; this does not
install or authorize integrations or force experimental features on.

Built-in web search handles external research; the browser tool handles the
companion page and scoped Chrome interaction. Command and file tools retain
the connector's read-only sandbox and `untrusted` approval policy. Tool
availability also depends on the installed Codex version and selected model.
See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Linked conversations

New tabs opened from webpage links, Agent conversation links, or the browser tool
retain their source conversation. When both threads are available, the connector
records reciprocal parent/child notes with thread IDs and source page metadata.
The notes are appended with `thread/inject_items`, without copying history or
starting a model turn. The browser new-tab button and Agent + create independent
root conversations; Agent + copies page context and settings only. Opening another
view of the same Agent is not a branch.

Relationships are journaled under
`$CODEX_HOME/projects/tabgent/lineage/`. The native host checks
rollout markers to deduplicate retries, and flushes pending notes on resume and
before new input. Closed parents can be resumed briefly to record their note;
locked/unavailable threads retain pending notes until the connector can access them.
Agents can use the IDs to look up local Codex session history. Page titles and URLs
in the notes are explicitly untrusted data.

The chat renders each relationship as a chronological notice in the message stream,
using `bridge/thread/relations` to read the same durable records injected into the
model's context. Child chats identify their parent; parent chats announce each child.
Titles link to existing conversation tabs and focus their windows. Closed tabs reopen
the same thread; IDs remain available in a details menu. Adjacent child notices created
within a minute collapse into a group. Reconnects and duplicate notifications do not
duplicate notices.

## Page conversation history

The collapsible Page conversations drawer indexes thread IDs, titles, settings, and
associated URLs in `chrome.storage.local`. Conversation content stays in Codex's
session storage. Exact URLs (including queries and fragments) remain distinct; the
PDF viewer uses its original document URL. One conversation can be associated with
multiple URLs as its companion tab navigates.

Selecting history remaps the current Agent view to the existing session, or resumes
the stored thread ID when it is no longer active. It does not create lineage. Drafts
and attachments stay with their sessions. The index survives browser restarts, but
clearing extension data removes it. Existing open sessions are indexed on first use;
closed conversations predating this feature cannot be reconstructed reliably.

Only threads with an accepted user message enter page history. Merely opening or
cloning a chat and injected lineage notes do not qualify. Older index entries are
checked against Codex history on first access; empty entries are removed from the
index, while unavailable records remain hidden for a later retry.

## Per-message browser context

Each Agent view retains its own companion tab, independently of its shared thread.
The connector prepends a text context item (tab ID, window ID, URL, title) to each
submitted message. Queued messages retain this snapshot when started or steered
from another view. When the companion tab has closed, the item keeps the page's last
known URL and title and adds `closed: true`. The UI hides this routing item and
continues showing the bound page in the composer, marked closed once it is. Page
titles and URLs are treated as untrusted data.

Every browser action requires an explicit `tabId`, including `context`, `tabs`, and
`open` (where it identifies the source window's tab). Missing IDs fail validation;
there is no implicit target. The message's originating tab anchors window scope.

Agent-authored Markdown links can carry the exact title `browser:current` or
`browser:new`. The Agent chooses using task context; the renderer converts the
marker into a localized hover hint and click intent. Missing or unknown markers
open a new tab. Modified clicks always request a new tab. Current-tab navigation
uses the clicking view's companion page, preserves the Agent view, and does not
create lineage. Browser tool navigation remains an explicit navigate/open choice.

Page history associates a thread with every URL on which the user submits a message. The URL is captured in that message’s browser context before the request, so later navigation cannot move the association. Navigation alone does not add an entry. The drawer shows conversations associated with the current tab URL plus the current conversation if it has user messages, deduplicated by thread ID. Including the current conversation does not persist a URL association. If the tab closes, the view keeps its last known page address.
