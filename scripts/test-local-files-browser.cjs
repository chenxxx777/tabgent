// Files opened from the computer (file://) in real Chromium, with the source extension and the
// real connector. A temporary profile, HOME and CODEX_HOME isolate the browser, the vault and
// Codex state, and Codex is the fixture app-server: no account, model or personal vault
// is used. Every file is generated fixture text in the temporary folder.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { vaultDocuments } = require('./vault-files.cjs'),
  { pathToFileURL } = require('node:url'),
  { execSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const { textPdf } = require(root + '/extension/tests/fixtures/text-pdf.cjs');
const extension = path.join(root, 'extension');
const shots = process.env.LOCAL_FILES_SHOTS;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const paperPdf = textPdf(
  [
    ['Chapter 1. Slow reading', 'Careful readers return to difficult passages.'],
    [
      'Chapter 2. Motivation',
      "Autonomy is the endorsement of one's own actions.",
      'It does not mean independence from other people.',
      'Readers who endorse a goal persist for longer.',
    ],
    ['Chapter 3. Practice', 'Short daily sessions build a durable habit.'],
  ],
  { title: 'Local Reading Fixture', author: 'Fixture Author' },
);
const markdown = `# Reading notes

Autonomy is the endorsement of one's own actions.

It does not mean independence from other people.
`;
const text = `Plain text notes from the computer.
Persistence follows the endorsement of goals.
Short daily sessions build a durable habit.
`;

(async () => {
  // realpath: macOS reports /var/... temporary folders as /private/var/... in file:// URLs.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-local-files-')));
  const mainProfile = path.join(temp, 'profile'),
    home = path.join(temp, 'home'),
    codexHome = path.join(home, 'codex'),
    vault = path.join(home, 'Tabgent'),
    // Documents' records, by ID (article-*, paper-*); docOf adds their Markdown files.
    books = path.join(vault, '.tabgent/documents'),
    articles = books,
    docOf = (id) => vaultDocuments(vault).find((doc) => doc.id === id),
    folder = path.join(temp, 'Documents');
  // The personal vault is never touched: its state is the same before and after.
  const personal = ['ReadingVault', 'Tabgent'].map((name) => path.join(os.homedir(), name));
  const personalState = () =>
    personal.map((dir) => (fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : null)).join();
  const personalBefore = personalState();
  fs.mkdirSync(folder);
  fs.mkdirSync(codexHome, { recursive: true });
  const files = {
    pdf: path.join(folder, 'reading paper.pdf'),
    moved: path.join(folder, 'Moved Copy.PDF'),
    md: path.join(folder, 'notes.md'),
    txt: path.join(folder, 'log.txt'),
    html: path.join(folder, 'index.html'),
    off: path.join(folder, 'later.md'),
    offPdf: path.join(folder, 'later.pdf'),
    // Chrome recognizes a PDF without a .pdf name by its bytes.
    unnamed: path.join(folder, 'scan-0001'),
  };
  fs.writeFileSync(files.pdf, paperPdf);
  fs.writeFileSync(files.md, markdown);
  fs.writeFileSync(files.txt, text);
  fs.writeFileSync(files.off, markdown);
  fs.writeFileSync(files.offPdf, paperPdf);
  fs.writeFileSync(files.unnamed, paperPdf);
  fs.writeFileSync(
    files.html,
    '<!doctype html><title>Local index</title><p><a id="paper" href="reading%20paper.pdf#page=2">The paper</a></p>',
  );
  const url = (file) => pathToFileURL(file).href;
  const digest = crypto.createHash('sha256').update(paperPdf).digest('hex');
  const urn = 'urn:sha256:' + digest;
  const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
  // Chrome's extension ID: from the manifest key, or from the folder of a key-less extension.
  const extensionId = (bytes) =>
    [...crypto.createHash('sha256').update(bytes).digest('hex')]
      .slice(0, 32)
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join('');
  const key = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).key;
  const keyedId = extensionId(Buffer.from(key, 'base64'));
  let id = keyedId,
    profile = mainProfile,
    extensionDir = extension;
  const codex = path.join(temp, 'codex');
  fs.writeFileSync(
    codex,
    `#!/bin/sh\nexec '${python}' '${path.join(extension, 'tests/fixtures/app-server-tools.py')}' "$@"\n`,
    { mode: 0o700 },
  );
  // The real host.py, with Codex discovery pointed at the fixture app-server. Reading a PDF's
  // page text can be made slow, as PDFKit is on a long book: the slow file holds the seconds.
  const slowText = path.join(temp, 'slow-pdf-text');
  const start =
    'import os, sys, time; native, codex, slow = sys.argv[1:4]; del sys.argv[1:4]; ' +
    'sys.path.insert(0, native); import pdf_text; read = pdf_text.extract; ' +
    'pdf_text.extract = lambda p: (os.path.exists(slow) and time.sleep(float(open(slow).read())), read(p))[1]; ' +
    'import host; host.executable = lambda: codex; host.main()';
  const connector = path.join(temp, 'connector');
  fs.writeFileSync(
    connector,
    `#!/bin/sh\nexport HOME='${home}' CODEX_HOME='${codexHome}'\nexec '${python}' -c '${start}' '${path.join(extension, 'native')}' '${codex}' '${slowText}' "$@" 2>>'${temp}/host.err'\n`,
    { mode: 0o700 },
  );
  // Chrome reads <user-data-dir>/NativeMessagingHosts, so nothing is installed globally.
  const registerHost = (profile, id) => {
    fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'NativeMessagingHosts/com.tabgent.codex.json'),
      JSON.stringify({
        name: 'com.tabgent.codex',
        description: 'Tabgent connector for local file tests',
        path: connector,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
  };
  registerHost(mainProfile, keyedId);
  const fileViewer = (file) => `chrome-extension://${id}/pdf/file.html?url=${url(file)}`;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      `<!doctype html><title>Web page</title><p id="p">A web page about reading.</p>
      <a id="file" href="${fileViewer(files.pdf)}">file viewer</a>
      <a id="viewer" href="chrome-extension://${id}/pdf/viewer.html?url=${url(files.pdf)}">viewer</a>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context,
    worker,
    passed = false;
  const logs = [];
  try {
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        viewport: { width: 1100, height: 900 },
        args: [
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
          '--remote-debugging-port=0',
        ],
      });
      context.on('page', (opened) => {
        opened.on('console', (message) => logs.push(message.text()));
        opened.on('pageerror', (error) => logs.push('pageerror: ' + error.message));
      });
      worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    }
    // After the extension reloads (file access changed), its new worker.
    async function reloaded() {
      const wake = await context.newPage();
      await until(async () => {
        await wake.goto(`chrome-extension://${id}/setup.html`).catch(() => {});
        return wake.url().startsWith('chrome-extension://');
      });
      await wake.close();
      worker = await until(() =>
        context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`)),
      );
      await until(() => worker.evaluate(() => !!chrome.runtime.id).catch(() => false));
    }
    // Strings follow the browser's UI language (macOS ignores --lang), so compare by key.
    const message = (key, ...args) =>
      worker.evaluate(([key, args]) => chrome.i18n.getMessage(key, args), [key, args]);
    const fileAccess = () => worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
    // chrome://extensions turns "Allow access to file URLs" on or off; Tabgent reloads.
    async function setFileAccess(on) {
      const settings = await context.newPage();
      await settings.goto(`chrome://extensions/?id=${id}`);
      await settings.evaluate(
        async ([id, on]) => {
          await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
          await chrome.developerPrivate.updateExtensionConfiguration({
            extensionId: id,
            fileAccess: on,
          });
        },
        [id, on],
      );
      await settings.close();
      await wait(1000);
      await reloaded();
      assert.equal(await until(async () => (await fileAccess()) === on), true);
    }

    // The PDF.js frame of a viewer page, once its text layers are rendered.
    async function viewer(page, pageNumber = 2) {
      await page.waitForURL('**/pdf/file.html?**');
      await page.frameLocator('#viewer').locator('.textLayer span').first().waitFor();
      const pdf = page.frames().find((f) => f.url().includes('/vendor/pdfjs/web/viewer.html'));
      await pdf.evaluate((n) => {
        PDFViewerApplication.page = n;
      }, pageNumber);
      await pdf
        .locator(`.page[data-page-number="${pageNumber}"] .textLayer .endOfContent`)
        .waitFor({ state: 'attached' });
      await wait(800);
      return pdf;
    }
    const painted = (frame) =>
      frame.evaluate(() => [...(CSS.highlights.get('tabgent-highlight') || [])].map(String).sort());
    const paintedAre = async (frame, expected) =>
      until(async () => JSON.stringify(await painted(frame)) === JSON.stringify(expected));
    // A needle's box in a frame's text, in page coordinates.
    async function textBox(page, frame, needle, scope) {
      const box = await frame.evaluate(
        ([needle, scope]) => {
          const walker = document.createTreeWalker(
            document.querySelector(scope) || document.body,
            NodeFilter.SHOW_TEXT,
          );
          while (walker.nextNode()) {
            const node = walker.currentNode,
              at = node.data.indexOf(needle);
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + needle.length);
            const r = range.getClientRects()[0];
            return { left: r.left, right: r.right, y: r.top + r.height / 2 };
          }
        },
        [needle, scope],
      );
      assert(box, `Text not found: ${needle}`);
      const offset =
        frame === page.mainFrame() ? { x: 0, y: 0 } : await page.locator('#viewer').boundingBox();
      return { left: offset.x + box.left, right: offset.x + box.right, y: offset.y + box.y };
    }
    async function drag(page, frame, needle, scope = 'body') {
      const box = await textBox(page, frame, needle, scope);
      await page.mouse.move(box.left + 1, box.y);
      await page.mouse.down();
      await page.mouse.move(box.right - 1, box.y, { steps: 8 });
      await page.mouse.up();
      await wait(300);
    }
    // CDP sees the reading layer's closed shadow root; page scripts cannot.
    async function pierce(page, find) {
      const client = await page.context().newCDPSession(page);
      const { root: document } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      let found = null;
      (function walk(node) {
        found ??= find(node);
        for (const child of [
          ...(node.children || []),
          ...(node.shadowRoots || []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ])
          walk(child);
      })(document);
      return { client, found };
    }
    async function press(page, action) {
      const { client, found } = await pierce(page, (node) => {
        const attributes = node.attributes || [];
        const at = attributes.indexOf('data-action');
        return at >= 0 && attributes[at + 1] === action ? node.backendNodeId : null;
      });
      assert(found, `No ${action} button`);
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId: found });
      await client.detach();
      await page.mouse.click(
        (model.border[0] + model.border[4]) / 2,
        (model.border[1] + model.border[5]) / 2,
      );
    }
    async function layerHtml(page) {
      const { client, found } = await pierce(page, (node) =>
        node.localName === 'tabgent-reader' ? node.shadowRoots?.[0] : null,
      );
      const { outerHTML } = await client.send('DOM.getOuterHTML', {
        backendNodeId: found.backendNodeId,
      });
      await client.detach();
      return outerHTML;
    }
    // Evaluates in the side panel (chat.html) over CDP, awaiting promises.
    async function sidePanel() {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const target = await until(async () =>
        (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) =>
          t.url.endsWith('/ui/chat.html'),
        ),
      );
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
      let sequence = 0;
      const evaluate = async (expression) => {
        const id = ++sequence;
        const reply = new Promise((resolve) => {
          const listen = (e) => {
            const message = JSON.parse(e.data);
            if (message.id !== id) return;
            socket.removeEventListener('message', listen);
            resolve(message);
          };
          socket.addEventListener('message', listen);
        });
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { returnByValue: true, awaitPromise: true, expression },
          }),
        );
        return (await reply).result?.result?.value;
      };
      evaluate.close = () => socket.close();
      return evaluate;
    }
    const send = (panel, question) =>
      until(() =>
        panel(`(() => {
          const prompt = document.getElementById('prompt'), button = document.getElementById('send');
          prompt.value = ${JSON.stringify(question)};
          prompt.dispatchEvent(new Event('input'));
          if (button.disabled) return false;
          button.click();
          return true;
        })()`),
      );
    const folders = (dir, prefix) =>
      fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith(prefix)) : [];
    const anchorsOf = (dir, name) =>
      JSON.parse(fs.readFileSync(path.join(dir, name, 'anchors.json'), 'utf8'));
    const selectionOf = (tabId) =>
      worker.evaluate(async (tabId) => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        return (
          conversations
            .map(([, s]) => s.selection)
            .find((s) => s?.highlight && s.tabId === tabId) || null
        );
      }, tabId);
    const tabIdOf = (page) =>
      worker.evaluate(
        async (href) => (await chrome.tabs.query({})).find((tab) => tab.url === href)?.id,
        page.url(),
      );

    // 1. Without "Allow access to file URLs", the first file opened shows the explanation
    // once; the side panel reminds and opens Tabgent's settings. Turning access on makes the
    // files already open work without reloading them. This runs in its own profile with a copy
    // of the extension without its manifest key: Chromium keeps file access for a keyed
    // extension loaded from the command line after the setting is turned off.
    extensionDir = path.join(temp, 'extension-keyless');
    fs.cpSync(extension, extensionDir, {
      recursive: true,
      filter: (source) =>
        !['tests', 'native'].includes(path.relative(extension, source).split(path.sep)[0]),
    });
    const keyless = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json')));
    delete keyless.key;
    fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify(keyless));
    id = extensionId(Buffer.from(extensionDir));
    profile = path.join(temp, 'profile-keyless');
    registerHost(profile, id);
    await launch();
    assert.equal(new URL(worker.url()).host, id);
    await setFileAccess(false);
    const prompts = () =>
      context.pages().filter((p) => p.url() === `chrome-extension://${id}/file-access.html`);
    const later = await context.newPage();
    await later.goto(url(files.off));
    const [prompt] = await until(() => prompts().length === 1 && prompts());
    assert(prompt, 'The explanation opens');
    await prompt.waitForSelector('body:not([style*="hidden"])');
    assert.equal(await prompt.textContent('h1'), await message('fileAccessTitle'));
    assert.equal(await prompt.isVisible('#open'), true);
    const laterPdf = await context.newPage();
    await laterPdf.goto(url(files.offPdf));
    await wait(1500);
    assert.equal(
      laterPdf.url(),
      url(files.offPdf),
      'Without access the PDF stays in Chrome viewer',
    );
    assert.equal(prompts().length, 1, 'The explanation opens only once');
    assert.equal(await later.evaluate(() => CSS.highlights.has('tabgent-highlight')), false);
    if (shots) await prompt.screenshot({ path: path.join(shots, 'file-access.png') });
    await prompt.click('#open');
    await prompt.waitForURL(`chrome://extensions/?id=${id}`);
    await prompt.close();
    // A side panel opened on a web page, which then shows a local file, shows the reminder.
    const reminded = await context.newPage();
    await reminded.goto(origin);
    await drag(reminded, reminded.mainFrame(), 'about reading', '#p');
    await press(reminded, 'ask');
    await reminded.bringToFront();
    let panel = await panelFor(origin + '/');
    await reminded.goto(url(files.off));
    assert(
      await until(() => panel(`document.getElementById('fileAccess').hidden === false`)),
      'The side panel reminds about file access',
    );
    assert.equal(
      await panel(`document.querySelector('#fileAccess span').textContent`),
      await message('fileAccessNotice'),
    );
    const settings = context.waitForEvent('page');
    await panel(`document.getElementById('fileAccessOpen').click()`);
    const opened = await settings;
    await opened.waitForURL(`chrome://extensions/?id=${id}`);
    await opened.close();
    panel.close();
    console.log('PASS without file access: one explanation, a side panel reminder, settings link');

    await setFileAccess(true);
    assert(
      await until(() => later.evaluate(() => CSS.highlights.has('tabgent-highlight'))),
      'An open Markdown file gets the reading layer',
    );
    await laterPdf.waitForURL('**/pdf/file.html?**');
    assert.equal(laterPdf.url(), fileViewer(files.offPdf), 'An open PDF switches to the viewer');
    assert.equal(await laterPdf.evaluate(() => history.length), 2);
    await drag(later, later.mainFrame(), 'independence from other people', 'pre');
    await press(later, 'highlight');
    assert(await until(() => folders(articles, 'article-later-md-').length === 1));
    console.log('PASS turning access on makes open local files work without reloading them');
    await context.close();
    [id, profile, extensionDir] = [keyedId, mainProfile, extension];
    await launch();
    if (!(await fileAccess())) await setFileAccess(true);

    // Main-frame commits per tab, to see what Chrome showed before Tabgent's viewer.
    const watchCommits = () =>
      worker.evaluate(() => {
        globalThis.commits = [];
        chrome.webNavigation.onCommitted.addListener((detail) => {
          if (detail.frameId === 0) globalThis.commits.push(detail);
        });
      });
    await watchCommits();

    // 2. A PDF opened from the computer goes straight to Tabgent's viewer in the same tab.
    let page = await context.newPage();
    await page.goto(url(files.pdf));
    let pdf = await viewer(page);
    assert.equal(page.url(), fileViewer(files.pdf));
    const commits = await worker.evaluate(() =>
      globalThis.commits.filter((c) => c.url !== 'about:blank'),
    );
    assert.deepEqual(
      commits.map((c) => [c.url, c.transitionQualifiers.includes('server_redirect')]),
      [[fileViewer(files.pdf), true]],
      'Chrome never shows its own viewer: the file:// navigation is redirected',
    );
    assert.equal(await page.evaluate(() => history.length), 2, 'No history entry for file://');
    assert.equal(await page.textContent('#title'), 'reading paper.pdf');
    assert(await page.isVisible('#native'), 'Open in Chrome viewer stays available');
    // The spread buttons are in file.html too, and switching works on a local PDF.
    assert.equal(await page.isVisible('#spread'), true, 'The spread buttons are in the toolbar');
    await page.click('#spreadOdd');
    assert.equal(
      await until(
        async () => (await pdf.evaluate(() => PDFViewerApplication.pdfViewer.spreadMode)) === 1,
      ),
      true,
      'A local PDF switches to two-page view',
    );
    assert.equal(await page.getAttribute('#spreadOdd', 'aria-pressed'), 'true');
    await page.click('#spreadNone');
    assert.equal(
      await until(
        async () => (await pdf.evaluate(() => PDFViewerApplication.pdfViewer.spreadMode)) === 0,
      ),
      true,
      'A local PDF returns to one page',
    );
    // Switching spreads scrolls back to the start; return to page 2 for the highlight below.
    await pdf.evaluate(() => (PDFViewerApplication.page = 2));
    await pdf
      .locator('.page[data-page-number="2"] .textLayer .endOfContent')
      .waitFor({ state: 'attached' });
    await wait(1500);
    assert.deepEqual(folders(books, 'paper-'), [], 'Opening a PDF writes nothing to the vault');
    console.log(
      'PASS a local PDF opens in Tabgent viewer without Chrome viewer or a file:// entry',
    );
    if (shots) await page.screenshot({ path: path.join(shots, 'local-pdf.png') });

    // 3. Highlight: the PDF is named by its bytes and copied into the vault with its notes.
    const first = "endorsement of one's own actions";
    await drag(page, pdf, first, '.page[data-page-number="2"] .textLayer');
    await press(page, 'highlight');
    const paper = await until(() => folders(books, 'paper-local-reading-fixture-')[0]);
    assert(paper, 'The highlight creates a paper document');
    assert(await until(() => anchorsOf(books, paper).highlights.length === 1));
    let data = anchorsOf(books, paper);
    assert.deepEqual(
      [data.document.kind, data.document.url, data.document.title, data.document.meta],
      ['pdf', urn, 'Local Reading Fixture', { author: 'Fixture Author' }],
    );
    assert.equal(data.highlights[0].text, first);
    assert.equal(data.highlights[0].anchor.page, 2);
    assert(await paintedAre(pdf, [first]), 'The highlight is painted');
    const original = path.join(books, paper, 'original.pdf');
    // The copy is stored at once; its page text follows in the background.
    const sourceFile = path.join(books, paper, 'source.json');
    assert(
      await until(
        () =>
          fs.existsSync(sourceFile) && !JSON.parse(fs.readFileSync(sourceFile, 'utf8')).textPending,
      ),
    );
    assert.deepEqual(fs.readFileSync(original), paperPdf, 'The vault copy is byte-identical');
    const record = JSON.parse(fs.readFileSync(path.join(books, paper, 'source.json'), 'utf8'));
    assert.deepEqual(
      [record.kind, record.sha256, record.name, record.size],
      ['pdf', digest, 'reading paper.pdf', paperPdf.length],
    );
    // Page text for Codex, read by the connector with macOS PDFKit: a section per page.
    assert.deepEqual(
      [...docOf(paper).fullText.matchAll(/<!-- tabgent:page (\d+) -->/g)].map((m) => m[1]),
      ['1', '2', '3'],
    );
    assert.equal(docOf(paper).notesPath, path.join(vault, 'PDFs/Local Reading Fixture.md'));
    assert.match(docOf(paper).notes, new RegExp(`^source: "${urn}"$`, 'm'));
    console.log('PASS a highlight names the local PDF by its hash and copies it into the vault');

    // 4. Ask AI opens the side panel from the click and binds the conversation to the highlight.
    const pdfTab = await tabIdOf(page);
    const second = 'independence from other people';
    await drag(page, pdf, second, '.page[data-page-number="2"] .textLayer');
    await press(page, 'ask');
    assert(await until(() => anchorsOf(books, paper).highlights.length === 2));
    const asked = await until(() => selectionOf(pdfTab));
    assert.deepEqual(asked.highlight, { documentId: paper, highlightId: 'h002', kind: 'pdf' });
    assert.equal(asked.url, urn);
    assert.equal(asked.locator.kind, 'pdf');
    await page.bringToFront();
    panel = await panelFor(url(files.pdf));
    assert.match(
      await until(() => panel(`document.getElementById('readingLabel')?.textContent || ''`)),
      /^(Highlight 2|高亮 2)$/,
    );
    assert(await send(panel, 'Why is autonomy not independence?'));
    assert(await until(() => anchorsOf(books, paper).turns.length === 1, 15000));
    assert.match(
      docOf(paper).discussions,
      /## 高亮 002[\s\S]*Why is autonomy not independence\?[\s\S]*Fixture answer 1\./,
    );
    // The browser context names the file; Codex reads it page by page in the viewer.
    const threads = () =>
      JSON.parse(fs.readFileSync(path.join(codexHome, 'fixture-threads.json'), 'utf8'));
    const sent = Object.values(threads()).flat()[0].items[0].content;
    assert(
      sent.some((part) => part.text?.includes(JSON.stringify(url(files.pdf)).slice(1, -1))),
      'The page context names the local file',
    );
    panel.close();
    console.log('PASS Ask AI on the local PDF binds the highlight and saves the turn');

    // 5. A note written in the highlight popover is saved to its vault document.
    const note = '我的看法: endorsement, not isolation.';
    const target = await textBox(page, pdf, second, '.page[data-page-number="2"] .textLayer');
    await page.mouse.click(target.left + 4, target.y);
    await wait(300);
    await press(page, 'note');
    await page.keyboard.type(note);
    await page.keyboard.press('Control+Enter');
    assert(await until(() => anchorsOf(books, paper).highlights[1].note === note));
    console.log('PASS a note on a local PDF highlight is saved to the vault');

    // 6. After a restart the file reopens with its highlights and note. A moved and renamed
    // copy is the same document, and importing the file in the library reuses it.
    await context.close();
    await launch();
    page = await context.newPage();
    await page.goto(url(files.pdf));
    pdf = await viewer(page);
    assert(await paintedAre(pdf, [first, second].sort()), 'Highlights restored after a restart');
    const reopened = await textBox(page, pdf, second, '.page[data-page-number="2"] .textLayer');
    await page.mouse.click(reopened.left + 4, reopened.y);
    await wait(300);
    assert((await layerHtml(page)).includes(`<span>${note}</span>`), 'The note shows on click');
    fs.renameSync(files.pdf, files.moved);
    await page.goto(url(files.moved));
    pdf = await viewer(page);
    assert.equal(page.url(), fileViewer(files.moved), 'An upper-case .PDF name is redirected');
    assert(await paintedAre(pdf, [first, second].sort()), 'A moved file keeps its notes');
    fs.renameSync(files.moved, files.pdf);
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/epub/reader.html`);
    await page.waitForSelector('#start:not([hidden])');
    await page.setInputFiles('#file', files.pdf);
    await page.waitForURL('**/pdf/viewer.html?**');
    assert.equal(page.url(), `chrome-extension://${id}/pdf/viewer.html?url=${urn}`);
    assert.deepEqual(folders(books, 'paper-'), [paper], 'The import reuses the same document');
    await page.frameLocator('#viewer').locator('.textLayer span').first().waitFor();
    pdf = page.frames().find((f) => f.url().includes('/vendor/pdfjs/web/viewer.html'));
    await pdf.evaluate(() => (PDFViewerApplication.page = 2));
    assert(await paintedAre(pdf, [first, second].sort()), 'The imported copy shows the notes');
    await page.close();
    console.log('PASS restart restore / a moved file keeps its notes / import shares them');

    // 7. Markdown and text files: the reading layer works on the page Chrome shows.
    const md = await context.newPage();
    await md.goto(url(files.md));
    assert.equal(await md.evaluate(() => document.contentType), 'text/markdown');
    await drag(md, md.mainFrame(), 'independence from other people', 'pre');
    await press(md, 'highlight');
    const note1 = await until(() => folders(articles, 'article-notes-md-')[0]);
    assert(note1, 'The Markdown file is a vault document');
    assert(await until(() => anchorsOf(articles, note1).highlights.length === 1));
    data = anchorsOf(articles, note1);
    assert.deepEqual(
      [data.document.kind, data.document.url, data.document.title],
      ['web', url(files.md), 'notes.md'],
    );
    assert.equal(
      await until(() => md.evaluate(() => CSS.highlights.get('tabgent-highlight')?.size === 1)),
      true,
    );
    await drag(md, md.mainFrame(), "endorsement of one's own actions", 'pre');
    await press(md, 'ask');
    assert(await until(() => anchorsOf(articles, note1).highlights.length === 2));
    const mdTab = await tabIdOf(md);
    const mdAsked = await until(() => selectionOf(mdTab));
    assert.equal(mdAsked.url, url(files.md));
    assert.deepEqual(mdAsked.highlight, { documentId: note1, highlightId: 'h002', kind: 'web' });
    await md.bringToFront();
    panel = await panelFor(url(files.md));
    assert(await send(panel, 'What does endorsement mean here?'));
    assert(await until(() => anchorsOf(articles, note1).turns.length === 1, 15000));
    panel.close();
    const txt = await context.newPage();
    await txt.goto(url(files.txt));
    assert.equal(await txt.evaluate(() => document.contentType), 'text/plain');
    await drag(txt, txt.mainFrame(), 'endorsement of goals', 'pre');
    await press(txt, 'ask');
    const log = await until(() => folders(articles, 'article-log-txt-')[0]);
    assert(log && (await until(() => anchorsOf(articles, log).highlights.length === 1)));
    assert.equal(anchorsOf(articles, log).document.url, url(files.txt));
    const txtTab = await tabIdOf(txt);
    const txtAsked = await until(() => selectionOf(txtTab));
    assert.equal(txtAsked.text, 'endorsement of goals');
    // A directory listing is not a document: no reading layer and no vault entry.
    const listing = await context.newPage();
    await listing.goto(url(folder) + '/');
    await wait(1000);
    assert.equal(await listing.evaluate(() => CSS.highlights.has('tabgent-highlight')), false);
    assert.equal(await md.evaluate(() => CSS.highlights.has('tabgent-highlight')), true);
    console.log(
      'PASS Markdown and text files: highlight and Ask AI; directory listings are skipped',
    );

    // The library lists a local text file and reopens it from its place on the computer.
    const library = await context.newPage();
    await library.goto(`chrome-extension://${id}/epub/reader.html`);
    await library.waitForSelector('#start:not([hidden])');
    const entry = library.locator(`#books .item[data-document="${note1}"]`);
    await entry.waitFor();
    assert.equal(await entry.getAttribute('href'), url(files.md));
    assert((await entry.textContent()).includes(await message('libraryKindFile')));
    await entry.click();
    await library.waitForURL(url(files.md));
    assert(
      await until(() =>
        library.evaluate(() => CSS.highlights.get('tabgent-highlight')?.size === 2),
      ),
      'The reopened file restores its highlights',
    );
    await library.close();
    console.log('PASS the library lists a local text file and reopens it with its highlights');

    // 8. Only a file:// navigation opens the local PDF viewer: a link in a local page does,
    // a website cannot open file.html, and viewer.html never reads a file:// source.
    const index = await context.newPage();
    await index.goto(url(files.html));
    await index.click('#paper');
    await index.waitForURL('**/pdf/file.html?**');
    assert.equal(index.url(), fileViewer(files.pdf) + '#page=2');
    const web = await context.newPage();
    await web.goto(origin);
    await web.click('#file');
    await wait(1000);
    assert(!web.url().startsWith(`chrome-extension://${id}/`), web.url());
    await web.goto(origin);
    await web.click('#viewer');
    await web.waitForURL('**/pdf/viewer.html?**');
    assert.equal(
      await until(() => web.textContent('#status')),
      await message('pdfInvalid'),
      'viewer.html refuses a file:// source',
    );
    await web.close();
    console.log('PASS a local link opens the file viewer; websites cannot open it for a file');

    // 9. Agent tools: local tabs are readable in scope but read-only, and Agent cannot open
    // file:// URLs. The fixture app-server calls the browser tool like the model would, for
    // each `TOOL {json}` line of a message, and records the results.
    const toolCalls = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(codexHome, 'fixture-tools.json'), 'utf8'));
      } catch {
        return [];
      }
    };
    const tools = async (panel, calls) => {
      const before = toolCalls().length,
        turns = Object.values(threads()).flat().length;
      assert(await send(panel, calls.map((call) => 'TOOL ' + JSON.stringify(call)).join('\n')));
      const done = await until(
        () => toolCalls().length >= before + calls.length && toolCalls().slice(before),
        20000,
      );
      assert(done, 'The tool calls completed');
      // The turn finishes before the next message.
      assert(await until(() => Object.values(threads()).flat().length > turns));
      return done.map(({ result }) => {
        const text = result.contentItems[0].text;
        try {
          return { success: result.success, value: JSON.parse(text) };
        } catch {
          return { success: result.success, value: text };
        }
      });
    };
    async function panelFor(href) {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      // Each side panel shows its companion page's address in the context details.
      for (let attempt = 0; attempt < 50; attempt++) {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
          (t) => t.url.endsWith('/ui/chat.html'),
        );
        for (const target of targets) {
          const panel = await sidePanelAt(target);
          if ((await panel(`document.getElementById('contextFullUrl').textContent`)) === href)
            return panel;
          panel.close();
        }
        await wait(200);
      }
      throw Error('No side panel for ' + href);
    }
    async function sidePanelAt(target) {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
      let sequence = 0;
      const evaluate = async (expression) => {
        const id = ++sequence;
        const reply = new Promise((resolve) => {
          const listen = (e) => {
            const message = JSON.parse(e.data);
            if (message.id !== id) return;
            socket.removeEventListener('message', listen);
            resolve(message);
          };
          socket.addEventListener('message', listen);
        });
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { returnByValue: true, awaitPromise: true, expression },
          }),
        );
        return (await reply).result?.result?.value;
      };
      evaluate.close = () => socket.close();
      return evaluate;
    }
    const indexTab = await tabIdOf(index);
    const listingTab = await tabIdOf(listing);
    await md.bringToFront();
    panel = await panelFor(url(files.md));
    const results = await tools(panel, [
      { action: 'navigate', tabId: mdTab, url: url(files.txt) },
      { action: 'open', tabId: mdTab, url: url(files.txt) },
      { action: 'read', tabId: mdTab },
      { action: 'click', tabId: mdTab, x: 20, y: 20 },
      { action: 'type', tabId: mdTab, text: 'x' },
      { action: 'tabs', tabId: mdTab },
      { action: 'read', tabId: indexTab, page: 2 },
      { action: 'read', tabId: listingTab },
      { action: 'screenshot', tabId: mdTab },
    ]);
    const [navigate, open, read, click, type, listed, pdfRead, listingRead, screenshot] = results;
    assert.deepEqual(navigate, { success: false, value: 'Only HTTP(S) URLs are allowed' });
    assert.deepEqual(open, { success: false, value: 'Only HTTP(S) URLs are allowed' });
    assert.equal(read.success, true);
    assert.equal(read.value.url, url(files.md));
    assert.match(read.value.text, /independence from other people/);
    for (const refused of [click, type]) {
      assert.equal(refused.success, false);
      assert.match(refused.value, /read-only for Agent/);
    }
    const listedUrls = listed.value.map((tab) => tab.url);
    assert(listedUrls.includes(url(files.md)) && listedUrls.includes(url(files.txt)));
    assert(listedUrls.includes(url(files.pdf) + '#page=2'), 'A local PDF is listed by its file');
    assert(!listedUrls.includes(url(folder) + '/'), 'A directory listing is not listed');
    assert.equal(pdfRead.success, true);
    assert.equal(pdfRead.value.url, url(files.pdf) + '#page=2');
    assert.equal(pdfRead.value.pages, 3);
    assert.match(pdfRead.value.text, /Autonomy is the endorsement/);
    // Viewer actions stay available on a local PDF; pointer and keys do not.
    assert.deepEqual(pdfRead.value.actions, [
      'selectText',
      'highlight',
      'savePdf',
      'screenshot',
      'scroll',
    ]);
    assert.deepEqual(listingRead, {
      success: false,
      value: 'Tab is outside the selected scope or is a protected page',
    });
    assert.equal(screenshot.success, true);
    assert.equal(await md.url(), url(files.md), 'The local tab did not move');
    assert.equal(
      (await context.pages()).filter((p) => p.url() === url(files.txt)).length,
      1,
      'No tab was opened on a local file',
    );
    panel.close();
    console.log('PASS Agent reads local tabs, cannot click or type there, and cannot open file://');

    // 10. A PDF Chrome shows in its own viewer (here one without a .pdf name; also one opened
    // while Chrome starts) switches to Tabgent's viewer, without a history entry. Open in
    // Chrome viewer keeps Chrome's viewer for that tab.
    const unnamed = await context.newPage();
    await unnamed.goto(url(files.unnamed)).catch(() => {});
    await unnamed.waitForURL('**/pdf/file.html?**');
    assert.equal(unnamed.url(), fileViewer(files.unnamed));
    assert.equal(await unnamed.evaluate(() => history.length), 2, 'The file:// entry is replaced');
    pdf = await viewer(unnamed);
    await unnamed.click('#native');
    await unnamed.waitForURL(url(files.unnamed));
    await wait(1500);
    assert.equal(unnamed.url(), url(files.unnamed), 'Chrome viewer stays: no redirect loop');
    // Agent reads a local PDF in Chrome's viewer through the connector, like an online one.
    const unnamedTab = await tabIdOf(unnamed);
    await md.bringToFront();
    panel = await panelFor(url(files.md));
    const [nativeRead] = await tools(panel, [{ action: 'read', tabId: unnamedTab, page: 2 }]);
    panel.close();
    assert.equal(nativeRead.success, true, JSON.stringify(nativeRead));
    assert.equal(nativeRead.value.contentType, 'application/pdf');
    assert.match(nativeRead.value.text, /Autonomy is the endorsement/);
    await unnamed.close();
    console.log('PASS a PDF in Chrome viewer switches to Tabgent viewer; Chrome viewer on request');

    // 12. An Agent tab outlives a local page, as a webpage's does: after the Markdown file, and
    // a local PDF whose viewer reloaded, close, the Agent tab names the closed file and keeps
    // asking and saving on the same highlight.
    function lastContexts(threadId) {
      const parts = threads()
        [threadId].at(-1)
        .items.find((item) => item.type === 'userMessage').content;
      const part = (prefix) =>
        JSON.parse(parts.find((p) => p.text?.startsWith(prefix)).text.replace(/^[^\n]*\n/, ''));
      return {
        page: part('Browser context for this message'),
        reading: part('Reading context for this message'),
      };
    }
    async function openAgentTab(panel) {
      const opened = context.waitForEvent('page');
      await panel(`document.getElementById('openAgent').click()`);
      const agent = await opened;
      await agent.waitForURL('**/ui/chat.html');
      assert(
        await until(() =>
          agent.evaluate(() => document.getElementById('connection').dataset.state === 'ready'),
        ),
        'The Agent tab connects',
      );
      return agent;
    }
    async function askAgent(agent, text, folder, dir) {
      const count = anchorsOf(dir, folder).turns.length + 1;
      await agent.fill('#prompt', text);
      await agent.press('#prompt', 'Enter');
      assert(await until(() => anchorsOf(dir, folder).turns.length === count, 15000), text);
      return anchorsOf(dir, folder).turns.at(-1);
    }
    await md.bringToFront();
    panel = await panelFor(url(files.md));
    let agent = await openAgentTab(panel);
    panel.close();
    await md.close();
    assert(
      await until(
        async () =>
          (await agent.textContent('#contextText')) ===
          (await message('pageClosedContext', 'notes.md')),
      ),
      await agent.textContent('#contextText'),
    );
    const mdThread = anchorsOf(articles, note1).turns[0].threadId;
    // A follow-up without a quote is saved in the file's discussion, in the same thread.
    let turn = await askAgent(agent, 'And after closing the file?', note1, articles);
    assert.deepEqual([turn.highlightId, turn.threadId], [null, mdThread]);
    let contexts = lastContexts(mdThread);
    assert.deepEqual([contexts.page.closed, contexts.page.url], [true, url(files.md)]);
    assert.equal(contexts.reading.document.url, url(files.md));
    assert.equal(contexts.reading.saving, 'document');
    await agent.close();

    const reread = await context.newPage();
    await reread.goto(url(files.pdf));
    pdf = await viewer(reread);
    await drag(reread, pdf, 'Readers who endorse a goal', '.page[data-page-number="2"] .textLayer');
    await press(reread, 'ask');
    assert(await until(() => anchorsOf(books, paper).highlights.length === 3));
    await reread.bringToFront();
    panel = await panelFor(url(files.pdf));
    assert(await send(panel, 'Why do they persist?'));
    assert(await until(() => anchorsOf(books, paper).turns.some((t) => t.highlightId === 'h003')));
    const pdfThread = anchorsOf(books, paper).turns.find((t) => t.highlightId === 'h003').threadId;
    agent = await openAgentTab(panel);
    panel.close();
    await reread.reload();
    await viewer(reread);
    await reread.close();
    assert(
      await until(
        async () =>
          (await agent.textContent('#contextText')) ===
          (await message('pageClosedContext', 'reading paper.pdf')),
      ),
      await agent.textContent('#contextText'),
    );
    turn = await askAgent(agent, 'Read its pages from my notes.', paper, books);
    assert.deepEqual([turn.highlightId, turn.threadId], [null, pdfThread]);
    contexts = lastContexts(pdfThread);
    assert.deepEqual([contexts.page.closed, contexts.page.url], [true, url(files.pdf)]);
    assert.equal(contexts.reading.document.url, urn);
    assert.equal(contexts.reading.document.fullText, docOf(paper).fullTextPath);
    await agent.close();
    console.log('PASS Agent tabs keep asking and saving after a local file or PDF closes');

    // 9. A long PDF from the computer whose page text takes PDFKit longer than a request may
    // wait (20 s here): its first Ask AI, Highlight and Comment are saved and painted at
    // once, the question about it is saved under the highlight, and another tab's highlight
    // is not held up. The page text follows in the background.
    fs.writeFileSync(slowText, '20');
    const filler = Array.from(
      { length: 30 },
      (_, n) => `Line ${n + 1}: careful readers return to difficult passages again.`,
    );
    const longPdf = (title) =>
      textPdf(
        Array.from({ length: 300 }, (_, i) =>
          i === 1
            ? [
                `Chapter 2. ${title}`,
                "Autonomy is the endorsement of one's own actions.",
                ...filler,
              ]
            : [`Chapter ${i + 1}. ${title}`, ...filler],
        ),
        { title, author: 'Fixture Author' },
      );
    const quote = "endorsement of one's own actions";
    const longs = {};
    for (const [action, title] of [
      ['ask', 'Long Ask Book'],
      ['highlight', 'Long Highlight Book'],
      ['comment', 'Long Comment Book'],
    ]) {
      const file = path.join(folder, `${action} long book.pdf`);
      fs.writeFileSync(file, longPdf(title));
      const tab = await context.newPage();
      await tab.goto(url(file));
      const frame = await viewer(tab);
      await drag(tab, frame, quote, '.page[data-page-number="2"] .textLayer');
      const pressed = Date.now();
      await press(tab, action);
      if (action === 'comment') {
        await wait(300);
        await tab.keyboard.type('Saved with its passage.');
        await tab.keyboard.press('Control+Enter');
      }
      const prefix = `paper-${title.toLowerCase().replaceAll(' ', '-')}-`;
      const dir = await until(() => folders(books, prefix)[0], 5000);
      assert(dir, `The first ${action} creates the document`);
      assert(
        await until(() => anchorsOf(books, dir).highlights.length === 1, 5000),
        `The first ${action} is saved at once`,
      );
      assert(await paintedAre(frame, [quote]), `The first ${action} is painted`);
      assert(Date.now() - pressed < 8000, `The first ${action} did not wait for the page text`);
      if (action === 'comment')
        assert.equal(anchorsOf(books, dir).highlights[0].note, 'Saved with its passage.');
      const source = path.join(books, dir, 'source.json');
      assert(await until(() => fs.existsSync(source), 5000), 'The original is copied at once');
      assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).textPending, true);
      assert(!(await layerHtml(tab)).includes('toast error'), 'No error is shown');
      longs[action] = { tab, frame, file, dir, source };
    }
    // While the page text is read, another tab's highlight saves at once.
    const elsewhere = await context.newPage();
    await elsewhere.goto(url(files.md));
    await drag(elsewhere, elsewhere.mainFrame(), 'Reading notes', 'pre');
    const notesBefore = anchorsOf(articles, note1).highlights.length;
    const elsewhereAt = Date.now();
    await press(elsewhere, 'highlight');
    assert(
      await until(() => anchorsOf(articles, note1).highlights.length === notesBefore + 1, 5000),
      'Another tab saves its highlight while the page text is read',
    );
    assert(Date.now() - elsewhereAt < 5000);
    await elsewhere.close();
    // Ask AI bound the side panel to the saved highlight; the answer is saved under it.
    const asking = longs.ask;
    const askTab = await tabIdOf(asking.tab);
    assert.deepEqual((await until(() => selectionOf(askTab))).highlight, {
      documentId: asking.dir,
      highlightId: 'h001',
      kind: 'pdf',
    });
    await asking.tab.bringToFront();
    panel = await panelFor(url(asking.file));
    assert(await send(panel, 'What is endorsement here?'));
    assert(
      await until(() => anchorsOf(books, asking.dir).turns.length === 1, 15000),
      'The answer is saved while the page text is still read',
    );
    assert.equal(anchorsOf(books, asking.dir).turns[0].highlightId, 'h001');
    panel.close();
    // The page text is written in the background, without the notes changing.
    assert(
      await until(() => !JSON.parse(fs.readFileSync(asking.source, 'utf8')).textPending, 40000),
      'The page text is written in the background',
    );
    const longRecord = JSON.parse(fs.readFileSync(asking.source, 'utf8'));
    assert.equal(longRecord.pageCount, 300);
    assert.match(docOf(asking.dir).fullText, /<!-- tabgent:page 2 -->/);
    assert.equal(anchorsOf(books, asking.dir).highlights.length, 1);
    assert.equal(anchorsOf(books, asking.dir).turns.length, 1);
    fs.rmSync(slowText);
    // After a reload the highlight is still painted.
    await asking.tab.reload();
    const reopenedLong = await viewer(asking.tab);
    assert(await paintedAre(reopenedLong, [quote]), 'The highlight is restored after a reload');
    for (const { tab } of Object.values(longs)) await tab.close();
    console.log(
      'PASS a long local PDF: first Ask AI, Highlight and Comment save at once; text follows',
    );

    assert(!logs.some((line) => line.startsWith('pageerror')), logs.join('\n'));
    assert.equal(personalState(), personalBefore, 'The personal vault was not touched');
    passed = true;
  } finally {
    await context?.close().catch(() => {});
    server.close();
    const errors = fs.existsSync(temp + '/host.err') && fs.readFileSync(temp + '/host.err', 'utf8');
    if (errors && !passed) console.error(errors.slice(-2000));
    if (!passed) console.error(logs.slice(-30).join('\n'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
