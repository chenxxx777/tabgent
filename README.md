<h1>
  <img src="docs/assets/wordmark.svg" width="196" height="44" alt="Tabgent">
</h1>

**Your agent in every tab.**

Tabgent is a Chrome extension that puts Codex in your browser sidebar. It can read the current page, compare tabs, explain and annotate PDFs, keep highlights and reading notes for webpages, PDFs and EPUB books, and click, fill forms or search websites for you.

[**Get started →**](#get-started) · [See it in action](#see-tabgent-in-action) · [Use cases](docs/use-cases.md)

**English** · [简体中文](README.zh-CN.md)

<sub>macOS · Chrome 142+ · Uses your Codex login · Open source under MIT · Early preview</sub>

## See Tabgent in action

Click any demo to view it full size.

<table>
  <tr>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/11-ask-about-tabs.gif"><img src="docs/assets/demos/11-ask-about-tabs.gif" alt="Ask about tabs" width="180"></a><br>
      <strong>Ask about tabs</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/12-hotel-comparison.gif"><img src="docs/assets/demos/12-hotel-comparison.gif" alt="Compare hotels" width="180"></a><br>
      <strong>Compare hotels</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/04-pdf-explain-highlight.gif"><img src="docs/assets/demos/04-pdf-explain-highlight.gif" alt="Read &amp; highlight papers" width="180"></a><br>
      <strong>Read &amp; highlight papers</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/03-github-code.gif"><img src="docs/assets/demos/03-github-code.gif" alt="Explore GitHub code" width="180"></a><br>
      <strong>Explore GitHub code</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/05-fill-search-form.gif"><img src="docs/assets/demos/05-fill-search-form.gif" alt="Fill search forms" width="180"></a><br>
      <strong>Fill search forms</strong>
    </td>
  </tr>
  <tr>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/13-manual.gif"><img src="docs/assets/demos/13-manual.gif" alt="Find steps in a manual" width="180"></a><br>
      <strong>Find steps in a manual</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/14-job-application.gif"><img src="docs/assets/demos/14-job-application.gif" alt="Fill a job application" width="180"></a><br>
      <strong>Fill a job application</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/15-event-registration.gif"><img src="docs/assets/demos/15-event-registration.gif" alt="Fill a registration form" width="180"></a><br>
      <strong>Fill a registration form</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/07-recipe-quantities.gif"><img src="docs/assets/demos/07-recipe-quantities.gif" alt="Adjust a recipe" width="180"></a><br>
      <strong>Adjust a recipe</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/10-page-history.gif"><img src="docs/assets/demos/10-page-history.gif" alt="Revisit past chats" width="180"></a><br>
      <strong>Revisit past chats</strong>
    </td>
  </tr>
</table>

[More examples and feature details →](docs/features.md)

## Read with highlights and notes

Highlight passages on webpages, in PDFs and in EPUB books, ask Codex about them, and keep each discussion as Markdown notes on your Mac.

- **Highlight, comment, or ask:** Select text on a webpage, in a file you opened in Chrome, in Tabgent's PDF viewer, in its EPUB reader, or in a clipped page or feed item. **Highlight** saves the passage; **Comment** saves the passage and your comment together; **Ask AI** also opens the sidebar with the passage quoted. Highlights and comments come back when you reopen the page, PDF or book, also after restarting Chrome, and saving them does not need Codex to be connected.
- **Comment on a passage:** Choose **Comment** on the selection, or click a highlight and choose **Comment** or **Edit comment**. Cancel or Esc saves nothing. The sidebar's highlight list shows and edits comments too. In the note, the comment is the **评论** line under its highlight.
- **Comment on a document and tag it:** Write a comment on the whole document and add tags under the title in Tabgent's reader, in the sidebar's page drawer, or under each document in the library, also without any highlight or clip. Tags you already use are suggested as you type; the library shows the documents with a tag when you click it, and renames, merges and deletes tags. Both live in the document's note (a **全文评论** section and the `tags` front matter field), so you can edit them in Obsidian too.
- **Discuss a passage:** Codex receives the passage, the text around it, the document's title, your comment on that highlight and on the whole document and its tags (marked as yours, apart from the author's text) and earlier discussion of it, so answers stay tied to what you are reading. Ask follow-ups in the same conversation. Later, click the highlight and choose **Open discussion** to continue it.
- **Notes you can open anywhere:** Each document gets one Markdown note in `~/Tabgent`, or in a folder you choose, filed by category (`Articles/`, `Tweets/`, `Videos/`, `Podcasts/`, `PDFs/`, `Books/`, `Local Files/`) as in a Readwise export. It lists every highlight with your comment and its location (section, page or chapter); your questions and Codex's answers are kept beside it in `Discussions/`, linked both ways, and full texts in `Full Document Contents/`. Questions about a whole document are saved too while **Save to reading notes** is on. Open the folder in Obsidian, VS Code or any text editor.
- **Connect what you read:** Ask how a passage relates to something you read before. Codex searches your notes with a read-only tool and names the document, highlight and file it used. It can also read a PDF page, or the page or chapter text saved with an imported PDF or EPUB book, when your question needs it.
- **Library:** Right-click the Tabgent toolbar button and choose **Open library**, or choose it in the sidebar's reading notes menu. It lists every document in your notes folder (webpages, online and imported PDFs, and EPUB books) with its highlight count, and reopens each one where it belongs, a clipped page in Tabgent's offline reader.
- **PDFs and books from your Mac:** Choose or drop a PDF or EPUB file in the library. It is copied into your notes folder, so it reopens from the library without the original file. A PDF opens in Tabgent's PDF viewer, where you highlight it, comment and ask Codex as with an online PDF; the text of each page is also saved as Markdown, so Codex can search and read the paper when its tab is closed. Books open in the EPUB reader, with contents, font size, and page or scroll layout.
- **Clip a page:** Right-click the Tabgent toolbar button or the page and choose **Clip this page**, or press ⌥⇧S. The page's main text, as you see it, is saved as Markdown in `Full Document Contents/`, linked from the page's note, so Codex can search and read it later and it opens in Obsidian. On X, it saves a post and the author's thread loaded on the page. **Open clipped copy** shows it offline in Tabgent's reader, where you highlight, comment and ask Codex as on the page.
- **Subscriptions:** Follow RSS, Atom and JSON feeds in the library's **Subscriptions** tab, by feed or website address or from an OPML file. Chrome checks them on a schedule, without cookies. Read items in Tabgent's reader (with the full text when a feed sends only a summary), sort them into later and archive, and highlight or ask about them: that saves the item in your notes folder like a clipped page.
- **Files you open in Chrome:** Double-click a PDF, Markdown, text or HTML file on your Mac and read it in Chrome as usual; select text to highlight it or ask Codex, as on a webpage. A PDF switches to Tabgent's PDF viewer in the same tab. Its first highlight copies it into your notes folder, so its notes stay with it when you move or rename the file, and importing the same PDF in the library shares them. Chrome needs your permission once: turn on **Allow access to file URLs** for Tabgent. Tabgent shows you how the first time you open a file.

[How reading notes work →](docs/features.md#read-and-keep-notes)

## More features

- **[File attachments](docs/features.md#give-tabgent-the-right-context):** Upload images, PDFs, Word documents (DOCX) or text files and ask questions about them alongside the current page.
- **[Chat history](docs/features.md#keep-your-chats-connected):** Find conversations for the current URL. Chats opened from links record their origin, so you can switch between related tabs. You can also open a chat in a full-page view.
- **[Follow-ups and task controls](docs/features.md#guide-a-task-as-it-runs):** Send messages while a task runs, use Steer to change the current task, or stop it. Edit or delete queued messages, and watch the pointer and activity log to see what is happening.
- **[Plans and goals](docs/features.md#guide-a-task-as-it-runs):** Use Plan mode, or set a task goal with an optional token budget. Goals can be paused and resumed.
- **[Models and permissions](docs/features.md#make-it-fit-your-work):** Choose a model, reasoning effort, approval mode and which browser windows Tabgent can use.
- **[Skills and tools](docs/features.md#make-it-fit-your-work):** Use skills, web search and services already configured in Codex. Copy answers or export conversation messages as Markdown.

Some features require a compatible Codex version, model or configuration.

## Other use cases

[Collect monthly invoices](docs/use-cases.md#collect-monthly-invoices-without-hunting-through-every-account) · [Fill a job application](docs/use-cases.md#apply-for-a-job-without-entering-your-resume-all-over-again) · [Compare rental listings](docs/use-cases.md#compare-rental-listings-without-losing-track-of-the-details)

[Prompts and instructions for seven use cases →](docs/use-cases.md)

These guides suggest ways to use Tabgent. The full workflows have not all been tested, and results depend on the website.

## Get started

### Requirements

- **macOS**, **Chrome 142+**, and **Python 3.9+**.
- **A compatible Codex installation, signed in.** See [compatibility details](docs/installation.md#requirements).
- Access to this GitHub repository while it is private.

Tabgent uses your existing Codex login and settings. It is not yet listed in the Chrome Web Store; installation requires loading the extension locally.

### Option 1: Ask Codex to install it

Copy this prompt into Codex:

```text
Install Tabgent from https://github.com/FibonaAI/tabgent.

Check that this Mac has Python 3.9+, Chrome 142+, and a compatible Codex
installation. Clone the repository into an unused folder using my existing
GitHub access, read docs/installation.md, and run:
python3 extension/native/install.py

Use my existing CODEX_HOME and Codex sign-in. Open chrome://extensions,
enable Developer mode, and load the unpacked extension from:
~/Library/Application Support/Tabgent/extension

Pin it and open the Agent sidebar. Keep my existing Chrome profile and tabs.
Use browser controls if available; otherwise guide me through the remaining
clicks. Help resolve missing access, dependencies, or sign-in, and verify
that the sidebar shows “Codex connected”. Report what you verified.
```

### Option 2: Install manually

1. Clone or download this repository.
2. Double-click **Install.command**, or run the following from the repository root:

   ```sh
   python3 extension/native/install.py
   ```

3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select:

   ```text
   ~/Library/Application Support/Tabgent/extension
   ```

   The installation path stays the same if you use a custom `CODEX_HOME`; that setting only selects your Codex account, configuration and data directory.

   To use Tabgent on PDFs and other files you open from your Mac, click **Details** under Tabgent and turn on **Allow access to file URLs**.

4. Pin Tabgent, open a webpage, and click its toolbar icon. Once you see **Codex connected**, try: **“Summarize this page.”**

**Updating:** rerun the installer and reload Tabgent in `chrome://extensions` after active tasks finish. See [installation and troubleshooting](docs/installation.md) for connection problems, custom setups, and uninstall instructions.

## Privacy & control

- **Choose how actions are approved:** Ask for approval, Approve for me, or Full access.
- **Choose which windows the assistant can use:** the current window or all windows. This setting only limits Tabgent’s browser actions; it does not restrict other Codex tools or connected services.
- **Connects to your local Codex installation:** Tabgent connects to Codex on your Mac. There is no separate Tabgent cloud service processing your conversations.
- **Conversation content is sent to Codex:** to answer questions or carry out tasks, your messages, supplied page content and relevant attachments are sent to your configured Codex service. They are not processed solely on your computer. For a file you opened from your Mac, its path is sent as the page address.
- **Subscriptions are fetched from your Mac:** while Chrome is running, it checks the feeds you subscribe to directly, without cookies or a referrer and without any feed service in between. **Pause all subscriptions** stops it. An item's full text is loaded from its page, with that site's cookies only when the item is on the subscription's own site (never to another site a link or redirect leads to); item images are loaded without cookies, with the Referer the article's page would send.
- **Reading notes stay in a local folder:** highlights, saved discussions, clipped page text, opened EPUB books and the PDFs from your Mac that you highlight are stored in your notes folder (`~/Tabgent` by default), and Tabgent does not upload it. The Tabgent reading-vault tool reads only the note files Tabgent writes there; Codex commands follow your permission mode and are not limited to those files. What Codex reads is sent to your Codex service like other conversation content.

Read [Privacy & permissions](docs/privacy.md) for data flow, storage locations, and Chrome permissions. Report security concerns using [SECURITY.md](SECURITY.md).

## Current limits

Tabgent is an early preview. **macOS and Chrome are the primary supported setup.** Some older Codex versions may need an update. Tabgent conversations do not synchronize live with Codex Desktop, and after a browser restart, saved conversations may no longer open their original tabs automatically.

Webpage highlights work on the top-level page, not inside frames. PDF highlights work in Tabgent's PDF viewer, which opens online (HTTP or HTTPS) PDFs, PDFs you open from your Mac and PDFs opened from the library, with selectable text. Files you open from your Mac need **Allow access to file URLs**; without it they open in Chrome as before, without Tabgent. If Chrome was closed, a PDF you double-click shows Chrome's own viewer for a moment before Tabgent's. Markdown files show as plain text. Notes on a Markdown, text or HTML file belong to its path, so they stay behind when you move or rename it. Agent can read files you opened but cannot click or type in them, and cannot open files itself. An online PDF and a copy of the same file from your Mac keep separate notes. Page text is saved with macOS PDFKit; scanned pages have no text, as there is no OCR. Fixed-layout EPUB books save highlights without displaying them. Clipping saves up to 50 images per page; SVG images and larger ones stay linked online. If a highlighted passage can no longer be found, Tabgent keeps the note and marks it as not found rather than highlighting other text; it cannot be re-attached yet.

## Contribute

Bug reports, suggestions and pull requests are welcome. Start with the [development guide](docs/development.md) and [contribution guidelines](CONTRIBUTING.md).

| Resource                                 | Contents                                     |
| ---------------------------------------- | -------------------------------------------- |
| [Installation](docs/installation.md)     | Setup, updates, troubleshooting, and removal |
| [Development](docs/development.md)       | Run locally, test, and package               |
| [Architecture](docs/architecture.md)     | Extension and native connector internals     |
| [Privacy & permissions](docs/privacy.md) | Data handling and access boundaries          |

This page and the user guide are available in English and Simplified Chinese. The technical guides above are currently in English.

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

Tabgent is an independent project, not affiliated with OpenAI or Google.
