# Data storage and permissions

## Data flow

Chrome extension → local Python native host → local Codex app-server → configured
Codex service. The extension has no separate project-operated cloud backend.
Local transport does not mean model processing stays on your computer.

The model receives what you submit and the browser results requested by its
tools. Selecting text captures a draft quote locally; sending a message includes
that quote and its location metadata. A selection is limited to 20,000 characters.
The truncated state is exposed in its tooltip and model context.

When a conversation is about a document, each message also carries a reading
context: the document's title, URL and kind, the bound highlight's text and
location, up to five earlier saved turns about that highlight, and the path of the
ReadingVault folder. When a question refers to earlier reading, Codex can list,
search and read the notes in that folder with the read-only `reading_vault` tool,
without an approval prompt. It reads only the notes Tabgent writes (`AGENTS.md` and
each document's `highlights.md`, `source.md` and `anchors.json`), never other files
in or outside the folder, and it cannot write. Notes it
reads are sent to the model like any other tool result.

Browser content and selection metadata are marked as untrusted context. Do not
assume prompt-injection defenses can make an arbitrary page safe. Scope checks
limit which tabs tools can access; they do not validate the intentions of a page.

## Permissions

| Permission                            | Why it is needed                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| HTTP(S) host access and `scripting`   | Read the selected page and observe text selection.                                    |
| `tabs` and `webNavigation`            | Associate conversations with tabs and preserve them across navigation.                |
| `sidePanel`                           | Display the conversation alongside the page.                                          |
| `storage`                             | Keep preferences, draft references, and tab/session state.                            |
| `nativeMessaging`                     | Connect to the installed local Python host.                                           |
| `debugger`                            | Perform trusted browser input and screenshots. Chrome may show an attachment notice.  |
| `declarativeNetRequestWithHostAccess` | Open online PDF documents in the bundled local viewer; allow native fallback per tab. |
| `contextMenus`                        | Quote selected text, including text in Chrome's native PDF viewer.                    |

Browser tools enforce current-window or all-windows scope on each operation.
Incognito and internal browser pages are excluded from ordinary page automation.
A native new tab may be navigated to an HTTP(S) page without inspecting its UI.

## Storage

Tabgent is installed in `~/Library/Application Support/Tabgent/`, independently
of Codex. Codex paths respect `CODEX_HOME`; the default is `~/.codex`.
The workspace is `$CODEX_HOME/projects/tabgent`. On upgrade, the previous
`browser-agent-connector` directory is moved there and kept as a compatibility
symlink so existing attachment paths remain valid.

| Location                                    | Contents                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `~/Library/Application Support/Tabgent/`    | Installed connector and, for normal installations, extension files.     |
| `$CODEX_HOME/projects/tabgent/attachments/` | User-uploaded file copies, each in a generated subdirectory.            |
| `~/ReadingVault/` or the configured folder  | Saved highlights, their page URLs and anchors, and saved discussions.   |
| Chrome extension local storage              | Reading-note saves waiting for a retry (at most 100).                   |
| `$CODEX_HOME/projects/tabgent/vault.json`   | The configured ReadingVault folder.                                     |
| Shared Codex session storage and index      | Conversation history and project association.                           |
| Chrome extension session storage            | Tab bindings, selection drafts, text drafts, and attachment references. |

The ReadingVault holds one folder per document. `highlights.md` contains the
document title, URL and metadata (author, site, publication date when the page
declares them), each highlighted passage with its location and time, and the saved
discussion: your question as typed (with any other quoted passage) and the final
answer, without tool output or reasoning. `anchors.json` holds the same turns plus
anchors, thread IDs and timestamps; `.tabgent/index.json` maps URLs to folders.
Highlight conversations are saved automatically. Questions about a page without a
highlight are saved only while **Reading notes** is on, which is the default only
when the page already has notes. Turning it off stops saving for that conversation;
it does not delete notes. Delete a highlight in the page, or edit or delete the
files yourself, to remove saved notes. Nothing in the vault is uploaded by Tabgent.

Removing an attachment from the composer removes its draft reference. It does not
delete the saved file. Sent attachments remain available for conversation history.
There is no automatic file-retention cleanup yet. Browser restarts can lose tab
pairings even though Codex history remains available.

The connector reuses Codex authentication. It does not copy credentials into the
extension or rewrite the user's `config.toml`. Native tools, including web search,
commands and configured integrations, inherit that configuration. Commands and
file operations follow the selected permission mode: Ask for approval uses a
read-only sandbox with untrusted-action approvals; Approve for me uses a
read-only sandbox with on-request approvals; Full access removes the sandbox
restriction and uses no approval prompts.
Browser tab/window scope applies to the plugin's browser tool; it is not a scope
restriction on native Codex tools. The attachment reader only accepts files
under the upload directory, and the reading-vault tool only reads the notes Tabgent
writes in the configured ReadingVault folder.

## Reporting a concern

See [SECURITY.md](../SECURITY.md). Do not include credentials, private page contents,
or unredacted conversation logs in public issues.

PDF.js renders documents locally in an extension page. PDF scripts and automatic
alt-text model downloads are disabled. Opening a PDF alone does not send it to
Codex; submitting a quote or asking Agent to read it supplies that context.
Highlights and comments are saved only when you download the edited PDF.

Webpage resources requested by the user are saved through Chrome Downloads, using browser authentication where applicable. Suggested filenames are placed under `Downloads/Tabgent`; Chrome may prompt or block a download according to its settings. Files are never automatically opened. Local file links in assistant replies can be opened with the default application or revealed in Finder when clicked.
