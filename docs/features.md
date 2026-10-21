# Tabgent user guide

[← Home](../README.md) · **English** · [简体中文](features.zh-CN.md)

Start with a page you already use and tell Tabgent what you need. These examples cover cooking, days out, documents and website tasks. Adapt the questions to your own plans.

[Real examples](#cook-for-your-household) · [PDFs](#work-with-pdfs) · [Reading notes](#read-and-keep-notes) · [Attachments and page context](#give-tabgent-the-right-context) · [Chat history](#keep-your-chats-connected) · [Task controls](#guide-a-task-as-it-runs) · [Settings and export](#make-it-fit-your-work)

## Cook for your household

The recipe makes twelve pancakes; you only need six. Ask for adjusted quantities and a short checklist you can follow.

Source: [Good Food — Easy pancakes](https://www.bbcgoodfood.com/recipes/easy-pancakes)

![Cook for your household](assets/en/cooking.png)

Ask Tabgent:

> I only want to make 6 pancakes. Read this recipe and halve its quantities. Give me a short ingredient checklist and cooking steps, with the cooking time. Use only the recipe on this page. Answer in English in under 130 words.

Open the recipe and ask, or select its ingredient list first. Follow up to convert units or make a shopping list.

## Plan a day out

Open two museums’ websites, give your child’s age, and compare admission, booking requirements and activities for children.

Source: [V&A South Kensington](https://www.vam.ac.uk/south-kensington/visit) · [Young V&A](https://www.vam.ac.uk/young)

![Plan a day out](assets/en/travel.png)

Ask Tabgent:

> I am choosing between V&A South Kensington and Young V&A for a family day out with a 7-year-old. Read these open official pages. Compare free admission, booking requirements and what children can do. Recommend one based on these pages and link to visitor information. Do not book anything. Answer in English in under 150 words.

Keep the official pages in one browser window and choose Current window. Check the latest details before travelling; this example makes no bookings.

## Work with PDFs

Ask about a difficult diagram with the paper beside it, then highlight the passage you want to return to.

Source: Vaswani et al., [Attention Is All You Need](https://arxiv.org/abs/1706.03762), page 3, Figure 1.

![Work with PDFs](assets/en/pdf.png)

Ask Tabgent:

> Read page 3 of this paper, including Figure 1. Explain the encoder and decoder in plain English, and why the decoder has masked attention. Highlight the selected passage on page 3. Keep the explanation under 130 words.

Select PDF text to ask about a specific passage. Passages you mark with Tabgent's **Highlight** or **Ask AI** toolbar are saved to your [reading notes](#read-and-keep-notes). Highlights, comments and edits made with the viewer's own annotation tools are kept only in a downloaded copy: after annotating, use the viewer’s download button to keep them. Scanned documents may not have selectable text. You can switch to Chrome’s viewer if a PDF will not open, but precise highlighting needs Tabgent’s PDF viewer. A PDF you double-click on your Mac opens in Tabgent’s PDF viewer too, once you allow file access (see [Files you open in Chrome](#read-and-keep-notes)); you can also open it from the library. Uploading an attachment lets you discuss it; it does not automatically open the annotation viewer. The paper belongs to its original authors.

### Link to a passage

A PDF link can include a page and an exact phrase. Opening it in Tabgent locates the phrase with a temporary search highlight:

```text
https://example.com/paper.pdf#page=3&search=ENCODED_TEXT&phrase=true
```

Replace `ENCODED_TEXT` with the original passage encoded using `encodeURIComponent`. Keep any query parameters before `#`. The page sets the starting location; the search can match text elsewhere in the document. This does not add a saved annotation. PDFs without searchable text may not produce a match.

## Understand a help page

When a help page is long, ask what to check first. This example explains why Zotero references can sync while PDF attachments remain missing.

Source: [Zotero — Syncing](https://www.zotero.org/support/sync)

![Understand a help page](assets/en/read.png)

Ask Tabgent:

> I have Zotero on two computers, but my PDFs are missing on the second one. Read this official page: what is the difference between data sync and file sync, and does the 300 MB limit apply to my references? Give me three practical checks, in English, under 130 words.

## Compare services across tabs

Price is only part of choosing a service. Here, Tabgent compares Zotero Storage and WebDAV for sharing 1 GB of PDFs with a research group.

Source: [Zotero Storage](https://www.zotero.org/storage) · [Syncing](https://www.zotero.org/support/sync)

![Compare services across tabs](assets/en/compare.png)

Ask Tabgent:

> Read both open Zotero pages. I need to share 1 GB of PDFs with a research group. Compare Zotero Storage and WebDAV in a small table: group-file support, who supplies storage, and relevant costs. Recommend an option based only on these pages. Do not purchase anything. Answer in English, under 150 words.

## Let Tabgent search a website

Know your search criteria but don’t want to set every field yourself? Ask Tabgent to enter a title and year in arXiv’s advanced search and find the matching paper.

Source: [arXiv Advanced Search](https://arxiv.org/search/advanced)

![Let Tabgent search a website](assets/en/act.png)

Ask Tabgent:

> Use this arXiv search form to find the original 2020 paper whose title contains Retrieval-Augmented Generation. Set the title field and the year, then run the search. Report the matching title and link in English. Do not use another search service.

## Read and keep notes

Tabgent saves your highlights and discussions as you read webpages, PDFs and EPUB books. They are Markdown files on your Mac, so a later reading, or a question about another document, can build on them.

**Highlight a passage.** Select text on a webpage, in a file you opened in Chrome, in Tabgent's PDF viewer or in the EPUB reader. A small toolbar appears beside the selection:

- **Highlight** saves the passage and marks it in soft yellow.
- **Ask AI** saves it too, opens the sidebar with the passage quoted, and starts a conversation about that highlight. Type a question, then keep asking follow-ups.

Click a highlighted passage to ask about it, open its discussion, or **Delete** it. Highlights are saved even when Codex is not connected, and they reappear when you reopen the page, PDF or book.

**Add your own note.** Click a highlighted passage and choose **Add note** to write what you think about it. Press ⌘ Enter or **Save note** to keep it, or Esc to cancel; saving an empty note removes it. The next time you click the passage, your note is shown above its actions, with **Edit note** to change it. The highlight list under **Page chats** in the sidebar and the EPUB reader's Highlights tab also show your notes, and the sidebar list can add or edit them. Like highlights, notes are saved without Codex.

**What Codex knows about the passage.** With each message, Tabgent tells Codex which document you are reading, the highlighted passage and its location, the text around it, your own note on that highlight, and earlier saved discussion of it. Your note is marked as yours, so Codex can tell your view from the author's. Codex is asked to answer around the source text, to keep the author's views apart from its own inferences, and to point to the location it refers to.

**Pick up where you left off.** Each highlight has its own conversation. Click the passage and choose **Open discussion** to reopen it with its earlier questions and answers and keep going, also after restarting Chrome. **Page chats** in the sidebar also lists the page's highlights: click one to scroll to it, or open its discussion from there.

**Ask about the whole document.** Ask without selecting anything to discuss the current page, PDF or book. The button beside the message box shows where the conversation is saved: a highlight, **Page notes** or **Not saved**. Open it to turn **Save to reading notes** on or off. It starts on when the document already has notes. Conversations about a highlight are always saved.

**Your notes folder.** Notes go to `~/Tabgent` unless you choose another folder in the same menu; notes already saved are not moved. It is laid out like a Readwise export, one Markdown file per document, named after its title, in a folder for its category: `Articles/` (webpages, also items saved from feeds), `Tweets/` (X posts), `Videos/`, `Podcasts/`, `PDFs/`, `Books/` (EPUB books) and `Local Files/` (Markdown, text or HTML files from your Mac). A folder appears with its first document. Each note starts with the title, source and metadata, then lists your highlights: the quoted passage, your **评论** (comment) under it, then its location (the section heading, page or chapter), the time and links to the passage and its discussion. Your discussions with Codex are kept apart, in `Discussions/` under the same name, with a section per highlight and **关于整篇** for questions about the whole document; the note and its discussions link to each other. A clipped page's text, and the text of a PDF or EPUB book opened from the library (or a PDF from your Mac once you highlight it), are in `Full Document Contents/`, one file per document with a section per chapter or page; images and covers, and copies of imported PDFs and books, are in `Attachments/`. The headings in the files are in Chinese. Tabgent's own records (the positions used to restore highlights, and the documents' list) are in the hidden `.tabgent/` folder. Open the folder in Obsidian, VS Code or any editor; you can rename notes or move them to other folders inside it, and Tabgent finds them again. Text you write outside Tabgent's marked blocks is kept, and when you change a marked block, Tabgent keeps your version as your own text before it updates the block. Change highlight comments in Tabgent: a comment edited inside the file is not read back.

**Ask about earlier reading.** Ask, for example, “Have I read anything before that makes a similar point?” Codex searches your notes folder with a read-only tool that needs no approval, then names the document, highlight and file it used, or says that it found nothing relevant. The tool reads only the note files Tabgent writes and cannot change them. When commands are allowed, Codex may also search the folder with shell commands; those follow your permission mode and are not limited to Tabgent's note files. It matches keywords, so questions that use words from your notes work best.

**Reading more of the source.** Codex reads more text only when a question needs it: a PDF page you ask about, a page of an imported PDF from its saved page text (also when its tab is closed), an EPUB chapter from the chapter text saved with the book, or the text of a page you clipped.

**Clip a page.** To keep a webpage's text, right-click the Tabgent toolbar button or the page and choose **Clip this page**, press ⌥⇧S (Alt+Shift+S, which you can change in `chrome://extensions/shortcuts`), or choose it in the sidebar's reading notes menu. Tabgent saves the page's main text as you see it, including text shown only when you are signed in, as its full text in `Full Document Contents/`, linked from the page's note. Navigation, sidebars, ads, comments, recommendations and footers are left out; links, tables and code are kept (also tables a page builds from other elements, with their rows and columns), as are author and guest cards, and up to 50 images are saved in `Attachments/Images/`, so Obsidian shows them offline. If the page shows text the extraction left out, Tabgent puts it back where it was and says so after saving. Captions stay right under their images. The author, date and cover image are saved too, also when a site shows them only on the page (for example WeChat articles and Meituan's tech blog). A YouTube video is saved with its description and its captions as a transcript (the video's own language, else its automatic captions, marked as such), in paragraphs that link to their moment in the video, under its chapters. A podcast episode is saved with the transcript its page offers. When there is no transcript (no captions, YouTube asks you to sign in or confirm you are not a bot, or returns no caption text), Tabgent says why and saves the description or show notes; turning on captions (CC) or opening **Show transcript** on the video and clipping again can help. If only links could be saved, Tabgent says so instead of reporting a normal clip, and the library marks both cases. Your highlights stay with the page. On X, open a single post or article first: Tabgent saves the post with the author's own replies in the thread that are loaded on the page, not other people's replies. When a page has little main text, you can save the whole page instead, or select text and choose **Clip selected text** in the reading notes menu. Clipping a page again asks before replacing its clip; if you edited its full text, your copy is kept as `<name>（编辑版 <time>）.md`. Codex can search and read clipped text with its reading-vault tool, and is told about it when you ask about the page.

**Read the clipped copy.** Choose **Open clipped copy** in the message after clipping or in the sidebar's reading notes menu, or click the page in the library. The copy opens in Tabgent's reader, offline: a clean page with the cover and saved images, the author and published date, adjustable text size, and your place kept. Highlight, add notes and **Ask AI** there as on the page: they belong to the same page, so they also show on the live page and in its discussions. **Original page** opens the live page, and **Delete clipped copy** removes the copy but keeps your highlights. Scripts, forms and remote content from the page never run or load in the reader.

**Library.** Right-click the Tabgent toolbar button and choose **Open library**, or choose **Open library** in the sidebar's reading notes menu to open it next to the page. It lists every document in your notes folder, most recently updated first: webpages, files from your Mac, online PDFs, imported PDFs and EPUB books, each with its category, author or site, highlight count and last update. Click one to reopen it: a webpage at its address (or a clipped page in Tabgent's reader, with **Original page** beside it), a Markdown, text or HTML file from its place on your Mac, an online PDF in Tabgent's PDF viewer, and an imported PDF or book from its copy in your notes folder.

**PDFs from your Mac.** Choose or drop a PDF file (up to 100 MB) in the library. Tabgent copies it into your notes folder (a copy you can open in other apps is in `Attachments/PDFs/`) and opens it in its PDF viewer, where highlights, notes, **Ask AI** and saved discussions work as for an online PDF. It reopens from the library without the original file, and opening the same file again reuses its copy. On macOS, the text of each page is saved in its full text with PDFKit, so Codex can search and read the paper even when its tab is closed. Scanned pages have no text, and a password-protected PDF opens once you enter its password in the viewer, without page text. The PDF is named by its title, or by its file name when it has none.

**Files you open in Chrome.** Double-click a PDF, Markdown, text or HTML file on your Mac and read it in Chrome as usual: there is nothing to import. Select text to **Highlight** or **Ask AI**, add notes and ask about the whole file, as on a webpage. A PDF switches to Tabgent's PDF viewer in the same tab (the address bar shows Tabgent's address, as for online PDFs); **Open in Chrome viewer** goes back to Chrome's viewer for that tab. Markdown, text and HTML files stay as Chrome shows them; Markdown is shown as plain text.

- **Allow file access once.** Chrome lets an extension read files only after you turn on **Allow access to file URLs** for it in `chrome://extensions`. The first time you open a file without it, Tabgent opens a page explaining this, with a button to Tabgent's settings; the sidebar shows a reminder on such files. After you turn it on, files that are already open start working without reloading.
- **Notes follow a PDF's content.** A PDF is named by the SHA-256 of its bytes, as in the library. Its first highlight or saved discussion copies it into your notes folder as `original.pdf` with its page text, so its notes stay with it when you move or rename the file, the library reopens it, and importing the same file shares the same notes. Opening a PDF alone saves nothing. PDFs larger than 100 MB keep their notes without a copy.
- **Notes on text files follow their path.** Markdown, text and HTML files change as you edit them, so their notes belong to their `file://` address, like a webpage's notes; highlights find their passage again after edits, as on webpages. Moving or renaming the file leaves its notes at the old address.
- **What Codex can do.** Codex reads a file you opened, page by page for a PDF, and sees its path as the page address. It cannot click or type in it, and cannot open files on its own; folder listings (`file:///…/`) are never treated as documents.

**Subscriptions.** The library's **Subscriptions** tab follows RSS, Atom and JSON feeds. Enter a feed address, or a website's address to find the feeds it declares, check the preview and choose **Subscribe**; **Import OPML** brings in the subscriptions you exported from another reader, with their folders as categories, and **Export OPML** saves yours. While Chrome is running, Tabgent checks each subscription about once an hour (as the feed asks, from every 30 minutes to once a day), without cookies; **Refresh all** checks now and **Pause all subscriptions** stops the schedule. The list shows each subscription's unread count and when it was last updated or why it failed, with **Retry**; **Settings** renames it, files it under a category, sets how often it is checked, pauses it or unsubscribes. A new subscription starts with its 20 newest items.

**Read and sort items.** The Subscriptions tab lists items by **Unread**, **Later**, **Archive** or **All**, one row per article (an article in two feeds shows once, from both). Click an item to read it in Tabgent's reader: the feed's text, cleaned, with its images; when the feed sends only a summary, Tabgent loads the full text from the article's page (set per subscription: **When the feed has only a summary**, **Always** or **Never**, with **Load full text** on request). Opening an item marks it read. In the list, **Mark as read**/**Mark as unread**, **Later**, **Archive** and **Original page** act on a row, **Mark all as read** on the unread view, and keys work too: j and k move, Enter opens, m read, l later, e archive, v original page. **Original page** opens the address without tracking parameters, so notes you make there join the item's.

**Keep an item.** Highlight, add a note or ask Codex in the reader as on a webpage: the first highlight or question, or **Save to library**, saves the item in your notes folder like a clipped page, with its text and images. Until then, items live only in one file in your notes folder (`.tabgent/feeds.db`), so subscriptions add no folders to Obsidian. Later and archive also work on saved items and clipped pages.

**EPUB books.** Choose or drop an EPUB file in the library. The book is copied into your notes folder with one Markdown file of text per chapter, and reopens at your last position. The reader has contents and highlights lists, font size controls, and page or scroll layout. Scripts in the book, and remote images, fonts and styles, are blocked.

**Limits.** Webpage highlights work on the top-level page, not inside frames; reload tabs that were open before Tabgent was installed or updated. PDF highlights work in Tabgent's PDF viewer, which opens online (HTTP or HTTPS) PDFs, PDFs you open from your Mac and PDFs opened from the library, with selectable text. Files from your Mac need **Allow access to file URLs**; without it they open in Chrome as before, without Tabgent. If Chrome was closed, a PDF you double-click shows Chrome's own viewer for a moment before Tabgent's. An online PDF and a copy of the same file from your Mac are separate documents with separate notes. Opening a PDF from your Mac needs the connector; page text needs macOS PDFKit, and there is no OCR for scanned pages. Imported files stay in the notes folder they were saved to: after you choose another folder, choose the file again in the library. Fixed-layout EPUB books save highlights without displaying them. Clipping reads the top-level page, not frames or content inside web components. SVG images, images over 5 MB, images beyond 50 or 30 MB per page, and images that fail to download stay linked online. When a highlighted passage can no longer be found, Tabgent keeps the note and marks it as not found instead of highlighting other text; it cannot be re-attached yet. Subscriptions are checked only while Chrome is running: after a pause, items older than what the feed still lists are missed. Feeds that need a login are not supported. Full text is read from the page without running its scripts, so pages built by scripts, challenge pages and cookie walls fall back to the feed's summary: open the original page and clip it there. See [Privacy & permissions](privacy.md) for what is stored and sent.

## Give Tabgent the right context

- **Ask about a passage:** Select text on the page, then ask your question in the sidebar. You can also right-click selected text and choose **Quote in Agent** to bring it into the conversation.
- **Check the target page:** The tab indicator beside the message box shows which page your next message refers to. Open its details before sending if several tabs share the conversation.
- **Add your own material:** Use the attachment button, paste a file or image, or drag it into the message box. Images can be previewed; PDF, DOCX and text attachments can be read alongside the page. Each message supports up to 10 files, up to 10 MiB each. Scanned PDFs may not contain readable text.
- **Let it use the live website:** Tabgent can read page content and inspect screenshots, click controls, type into forms, select options, scroll and move between pages. Its mouse actions show a virtual pointer. Website support varies.

## Keep your chats connected

Open **Page chats** to find conversations associated with the current URL. Sending a message associates that page with the conversation; simply navigating to a page does not. If you discuss several URLs in the same conversation, you can find it from each of those pages. Empty chats are not listed.

When opening a link creates a related conversation, the original chat links to the new one, and the new chat links back. Click the conversation name to switch to its tab. These links help you follow the work across pages; they do not copy the complete parent conversation into the new one. Returning to the original tab after a browser restart may not be available.

Click **+** in the Agent header to start a fresh chat on the same page. Use the open-in-new-page button to give the current chat more room in the full-page Agent view.

## Guide a task as it runs

- **See progress:** Expand the activity record to inspect the steps and tool activity. When a task has a plan, its progress appears in the conversation.
- **Queue a follow-up:** Send another instruction while the assistant is working. You can edit or delete queued messages before they run.
- **Change direction now:** Use **Steer** to send the instruction into the current task instead of waiting for the next one.
- **Stop:** Click the stop button. This does not undo actions already completed.
- **Plan first:** Enter `/plan` to switch to Plan mode, then describe the task. Use it again to leave Plan mode.
- **Work toward a goal:** Enter `/goal` to set an objective and an optional token budget. The goal controls let you inspect progress, edit, pause, resume or clear it. Goal support depends on your Codex version.

## Make it fit your work

**Model and reasoning.** Open the model selector beside the message box to choose a model and its reasoning effort. Available choices come from your Codex setup.

**Approvals and browser access.** Choose **Ask for approval**, **Approve for me** or **Full access**. Separately, choose **Current window** or **All windows** for browser actions. The window choice does not restrict other Codex tools or connected services. See [Privacy & permissions](privacy.md) for the boundaries of each setting.

**Skills and other tools.** Type `/skills` to browse and manage available skills, or `$` to select a skill for your message. Native Codex tools, including web search, and configured apps or MCP integrations can also be available in the conversation. Availability depends on your Codex version, model, permissions and configuration; Tabgent does not automatically connect new services for you.

**Keep the result.** Use **Copy** beneath an answer, or `/export` to download the conversation's user and assistant messages as Markdown. The export is text, not a backup of attachments or a browser recording. Use `/rename` to give the chat a recognizable name. Responses can display formatted tables, code and mathematical formulas.

**Manage longer conversations.** `/status` shows model and context usage information when available. `/compact` asks Codex to compact the conversation so you can continue with less context occupied.

<details>
<summary>How were these examples made?</summary>

Examples use real websites and actual conversations, run separately in English and Chinese. Screenshots place the page and conversation side by side without prewritten answers or replaced website content. Sources retain their original language and may change.

[cooking](assets/en/cooking.json) · [travel](assets/en/travel.json) · [pdf](assets/en/pdf.json) · [read](assets/en/read.json) · [compare](assets/en/compare.json) · [act](assets/en/act.json)

Maintainers can use [scripts/readme-screenshots.cjs](../scripts/readme-screenshots.cjs) to rerun these tasks. This requires signed-in Codex and the installed connector, performs real tasks and uses model quota.

```sh
TABGENT_EXAMPLE=cooking TABGENT_LANGUAGE=en node scripts/readme-screenshots.cjs
```

</details>
