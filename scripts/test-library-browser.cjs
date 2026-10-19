// The library and local PDFs in real Chromium with the source extension and the real
// connector. A temporary profile, HOME and CODEX_HOME isolate the browser, the vault and
// Codex state, and Codex is the fixture app-server: no account, model or personal
// ReadingVault is used. Every document is generated fixture text.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { execSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const { textPdf } = require(root + '/extension/tests/fixtures/text-pdf.cjs');
const extension = path.join(root, 'extension');
const shots = process.env.LIBRARY_SHOTS;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const chapters = [
  ['Chapter 1. Slow reading', 'Careful readers return to difficult passages.'],
  [
    'Chapter 2. Motivation',
    "Autonomy is the endorsement of one's own actions.",
    'It does not mean independence from other people.',
    'Readers who endorse a goal persist for longer.',
  ],
  ['Chapter 3. Practice', 'Short daily sessions build a durable habit.'],
];
const localPdf = textPdf(chapters, { title: 'Local Reading Fixture', author: 'Fixture Author' });
// No metadata title: the library names it by its file.
const untitledPdf = textPdf([['A second local file.', 'Untitled fixture text.']]);
const onlinePdf = textPdf(
  [['Online paper, page one.'], ['Goals that are endorsed persist for longer.']],
  { title: 'Online Fixture Paper' },
);
const article = `<!doctype html><html><head><title>On Autonomy</title></head><body>
<h1>On Autonomy</h1><p>Autonomy is the endorsement of one's own actions.</p>
<p>It is not the same as independence.</p></body></html>`;

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-library-'));
  const profile = path.join(temp, 'profile'),
    home = path.join(temp, 'home'),
    codexHome = path.join(home, 'codex'),
    vault = path.join(home, 'ReadingVault'),
    books = path.join(vault, 'Books');
  // The personal vault is never touched: its state is the same before and after.
  const personal = path.join(os.homedir(), 'ReadingVault');
  const personalState = () => (fs.existsSync(personal) ? fs.statSync(personal).mtimeMs : null);
  const personalBefore = personalState();
  const files = {
    local: path.join(temp, 'local-paper.pdf'),
    untitled: path.join(temp, 'untitled-notes.pdf'),
    epub: path.join(temp, 'small-book.epub'),
    text: path.join(temp, 'notes.txt'),
  };
  fs.writeFileSync(files.local, localPdf);
  fs.writeFileSync(files.untitled, untitledPdf);
  fs.writeFileSync(files.text, 'plain text');
  fs.mkdirSync(codexHome, { recursive: true });
  const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
  const built = spawnSync(python, [
    path.join(extension, 'tests/fixtures/epub_fixture.py'),
    files.epub,
  ]);
  assert.equal(built.status, 0, String(built.stderr));
  const digest = crypto.createHash('sha256').update(localPdf).digest('hex');
  const urn = 'urn:sha256:' + digest;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/papers/')) {
      response.setHeader('content-type', 'application/pdf');
      return void response.end(onlinePdf);
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(article);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const articleUrl = origin + '/articles/autonomy';
  const onlineUrl = origin + '/papers/motivation.pdf';
  let context,
    passed = false;
  try {
    // A web article and an online PDF already in the vault, as earlier reading left them.
    const seed = spawnSync(
      python,
      [
        '-c',
        `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import vault
settings = Path(sys.argv[2])
for method, params in json.loads(sys.argv[3]):
    reply = vault.handle(settings, method, params)
    assert "result" in reply, reply`,
        path.join(extension, 'native'),
        path.join(codexHome, 'projects/tabgent/vault.json'),
        JSON.stringify([
          [
            'vault/highlight/create',
            {
              url: articleUrl,
              title: 'On Autonomy',
              kind: 'web',
              text: 'endorsement',
              anchor: {
                kind: 'web',
                quote: {
                  exact: 'endorsement',
                  prefix: 'Autonomy is the ',
                  suffix: " of one's own",
                },
              },
            },
          ],
          [
            'vault/highlight/create',
            {
              url: onlineUrl,
              title: 'Online Fixture Paper',
              kind: 'pdf',
              text: 'endorsed',
              location: 'p. 2',
              anchor: {
                kind: 'pdf',
                page: 2,
                quote: { exact: 'endorsed', prefix: 'Goals that are ', suffix: ' persist for' },
              },
            },
          ],
        ]),
      ],
      { env: { ...process.env, HOME: home } },
    );
    assert.equal(seed.status, 0, String(seed.stderr));

    const key = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).key;
    const id = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')]
      .slice(0, 32)
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join('');
    const codex = path.join(temp, 'codex');
    fs.writeFileSync(
      codex,
      `#!/bin/sh\nexec '${python}' '${path.join(extension, 'tests/fixtures/app-server-replay.py')}' "$@"\n`,
      { mode: 0o700 },
    );
    // The real host.py, with Codex discovery pointed at the fixture app-server.
    const start =
      'import sys; native, codex = sys.argv[1:3]; del sys.argv[1:3]; sys.path.insert(0, native); ' +
      'import host; host.executable = lambda: codex; host.main()';
    const connector = path.join(temp, 'connector');
    fs.writeFileSync(
      connector,
      `#!/bin/sh\nexport HOME='${home}' CODEX_HOME='${codexHome}'\nexec '${python}' -c '${start}' '${path.join(extension, 'native')}' '${codex}' "$@" 2>>'${temp}/host.err'\n`,
      { mode: 0o700 },
    );
    // Chrome reads <user-data-dir>/NativeMessagingHosts, so nothing is installed globally.
    fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'NativeMessagingHosts/com.tabgent.codex.json'),
      JSON.stringify({
        name: 'com.tabgent.codex',
        description: 'Tabgent connector for library tests',
        path: connector,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    const libraryUrl = `chrome-extension://${id}/epub/reader.html`;
    const viewerUrl = (source) => `chrome-extension://${id}/pdf/viewer.html?url=${source}`;
    let worker, page, pdf;
    const logs = [];
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        viewport: { width: 1100, height: 900 },
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          '--remote-debugging-port=0',
        ],
      });
      context.on('page', (opened) => {
        opened.on('console', (message) => logs.push(message.text()));
        opened.on('pageerror', (error) => logs.push('pageerror: ' + error.message));
      });
      worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    }
    // Strings follow the browser's UI language (macOS ignores --lang), so compare by key.
    const message = (key, ...args) =>
      worker.evaluate(([key, args]) => chrome.i18n.getMessage(key, args), [key, args]);
    async function openLibrary() {
      page = await context.newPage();
      await page.goto(libraryUrl);
      await page.waitForSelector('#start:not([hidden])');
      return page;
    }
    const items = () =>
      page.$$eval('#books .item', (entries) =>
        entries.map((entry) => ({
          kind: entry.dataset.kind,
          title: entry.querySelector('.title').textContent,
          meta: entry.querySelector('.meta').textContent,
          href: entry.getAttribute('href'),
        })),
      );
    const listed = (count) => until(async () => (await items()).length === count && items());
    // The PDF.js frame of the viewer in this tab, once its text layers are rendered.
    async function viewer(pageNumber = 2) {
      await page.waitForURL('**/pdf/viewer.html?**');
      await page.frameLocator('#viewer').locator('.textLayer span').first().waitFor();
      pdf = page.frames().find((f) => f.url().includes('/vendor/pdfjs/web/viewer.html'));
      await pdf.evaluate((n) => {
        PDFViewerApplication.page = n;
      }, pageNumber);
      await pdf
        .locator(`.page[data-page-number="${pageNumber}"] .textLayer .endOfContent`)
        .waitFor({ state: 'attached' });
      await wait(800);
      return pdf;
    }
    const painted = () =>
      pdf.evaluate(() => [...(CSS.highlights.get('tabgent-highlight') || [])].map(String).sort());
    const paintedAre = async (expected) =>
      until(async () => JSON.stringify(await painted()) === JSON.stringify(expected));
    async function textPoint(needle) {
      const box = await pdf.evaluate((needle) => {
        const layer = document.querySelector('.page[data-page-number="2"] .textLayer');
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode,
            at = node.data.indexOf(needle);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          const r = range.getBoundingClientRect();
          return { left: r.left, right: r.right, y: r.top + r.height / 2 };
        }
      }, needle);
      const frame = await page.locator('#viewer').boundingBox();
      return { left: frame.x + box.left, right: frame.x + box.right, y: frame.y + box.y };
    }
    async function drag(needle) {
      const box = await textPoint(needle);
      await page.mouse.move(box.left + 1, box.y);
      await page.mouse.down();
      await page.mouse.move(box.right - 1, box.y, { steps: 8 });
      await page.mouse.up();
      await wait(300);
    }
    // CDP sees the toolbar inside the viewer frame's closed shadow root; scripts cannot.
    async function press(action) {
      const client = await page.context().newCDPSession(page);
      const { root: document } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      let target = null;
      (function walk(node) {
        const attributes = node.attributes || [];
        const at = attributes.indexOf('data-action');
        if (at >= 0 && attributes[at + 1] === action) target = node.backendNodeId;
        for (const child of [
          ...(node.children || []),
          ...(node.shadowRoots || []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ])
          walk(child);
      })(document);
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId: target });
      await client.detach();
      await page.mouse.click(
        (model.border[0] + model.border[4]) / 2,
        (model.border[1] + model.border[5]) / 2,
      );
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
    const folderOf = (prefix) =>
      until(() => fs.readdirSync(books).find((name) => name.startsWith(prefix)));
    const anchorsOf = (name) =>
      JSON.parse(fs.readFileSync(path.join(books, name, 'anchors.json'), 'utf8'));

    await launch();
    await openLibrary();
    const seeded = await listed(2);
    assert(seeded, 'The library lists the seeded documents');
    const byTitle = (list, title) => list.find((item) => item.title === title);
    const webItem = byTitle(seeded, 'On Autonomy'),
      onlineItem = byTitle(seeded, 'Online Fixture Paper');
    assert.equal(webItem.kind, 'web');
    assert.equal(webItem.href, articleUrl);
    assert(webItem.meta.includes(await message('libraryKindWeb')), webItem.meta);
    assert(webItem.meta.includes('127.0.0.1'));
    assert(webItem.meta.includes(await message('epubHighlightCount', '1')));
    const today = new Intl.DateTimeFormat(
      await worker.evaluate(() => chrome.i18n.getUILanguage()),
      { dateStyle: 'medium' },
    ).format(Date.now());
    assert(webItem.meta.includes(await message('libraryUpdated', today)), webItem.meta);
    assert.equal(onlineItem.kind, 'pdf');
    assert.equal(onlineItem.href, viewerUrl(onlineUrl));
    assert(onlineItem.meta.includes(await message('libraryKindPdf')));
    console.log('PASS the library lists vault documents with kind, highlights and update date');
    if (shots) await page.screenshot({ path: path.join(shots, 'library-seeded.png') });

    // Choose a local PDF: it is copied into the vault, then opens in PDF.js from that copy.
    await page.setInputFiles('#file', files.local);
    await viewer();
    assert.equal(page.url(), viewerUrl(urn));
    const local = await folderOf('paper-local-reading-fixture-');
    assert.match(local, /^paper-local-reading-fixture-[0-9a-f]{8}$/);
    assert.deepEqual(fs.readFileSync(path.join(books, local, 'original.pdf')), localPdf);
    const record = JSON.parse(fs.readFileSync(path.join(books, local, 'source.json'), 'utf8'));
    assert.deepEqual(
      [record.kind, record.file, record.sha256, record.name, record.size],
      ['pdf', 'original.pdf', digest, 'local-paper.pdf', localPdf.length],
    );
    let data = anchorsOf(local);
    assert.deepEqual(
      [data.document.kind, data.document.url, data.document.title, data.document.meta],
      ['pdf', urn, 'Local Reading Fixture', { author: 'Fixture Author' }],
    );
    assert.equal(await page.textContent('#title'), 'local-paper.pdf');
    assert(await page.isHidden('#native'), 'No Chrome viewer fallback for a vault copy');
    assert.deepEqual(fs.readdirSync(path.join(vault, '.tabgent/uploads')), []);
    // Page text for Codex, read by the connector with PDFKit at import.
    assert.deepEqual(fs.readdirSync(path.join(books, local, 'pages')), [
      '001.md',
      '002.md',
      '003.md',
    ]);
    assert.match(
      fs.readFileSync(path.join(books, local, 'pages/002.md'), 'utf8'),
      /^---\ntitle: "Page 2"\npaper: "Local Reading Fixture"[\s\S]*Autonomy is the endorsement of one's own actions\./,
    );
    console.log('PASS a chosen PDF is imported with its page text and opens in PDF.js');

    // Highlight and Ask AI on the imported PDF.
    const first = "endorsement of one's own actions";
    await drag(first);
    await press('highlight');
    assert(await until(() => anchorsOf(local).highlights.length === 1));
    const [highlight] = anchorsOf(local).highlights;
    assert.equal(highlight.text, first);
    assert.equal(highlight.anchor.kind, 'pdf');
    assert.equal(highlight.anchor.page, 2);
    assert(await paintedAre([first]), 'The highlight is painted');
    const second = 'independence from other people';
    await drag(second);
    await press('ask');
    assert(await until(() => anchorsOf(local).highlights.length === 2));
    const selection = await until(() =>
      worker.evaluate(async () => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        return conversations.map(([, s]) => s.selection).find((s) => s?.highlight) || null;
      }),
    );
    assert.deepEqual(selection.highlight, { documentId: local, highlightId: 'h002', kind: 'pdf' });
    assert.equal(selection.url, urn);
    assert.equal(selection.locator.kind, 'pdf');
    assert.equal(selection.locator.page, 2);
    assert.match(selection.context.after, /^\. Readers who endorse a goal/);
    const panel = await sidePanel();
    assert.match(
      await until(() => panel(`document.getElementById('readingLabel')?.textContent || ''`)),
      /^(Highlight 2|高亮 2)$/,
    );
    const question = 'Why is autonomy not independence?';
    assert(
      await until(() =>
        panel(`(() => {
          const prompt = document.getElementById('prompt'), button = document.getElementById('send');
          prompt.value = ${JSON.stringify(question)};
          prompt.dispatchEvent(new Event('input'));
          if (button.disabled) return false;
          button.click();
          return true;
        })()`),
      ),
    );
    assert(await until(() => anchorsOf(local).turns.length === 1, 15000), 'The turn is saved');
    const markdown = fs.readFileSync(path.join(books, local, 'highlights.md'), 'utf8');
    assert.match(markdown, new RegExp(`^source: "${urn}"$`, 'm'));
    assert.match(markdown, /## Highlight 002[\s\S]*Why is autonomy not independence\?/);
    assert.match(markdown, /Fixture answer 1\./);
    console.log('PASS highlights, Ask AI and saved turns on the imported PDF');
    if (shots) await page.screenshot({ path: path.join(shots, 'local-pdf.png') });

    // The side panel opens the library in a new tab next to the page.
    const opened = context.waitForEvent('page');
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingLibrary').click();
    })()`);
    panel.close();
    page = await opened;
    await page.waitForURL(libraryUrl);
    await page.waitForSelector('#start:not([hidden])');
    const three = await listed(3);
    assert(three, 'The library now lists the imported PDF');
    assert.equal(three[0].title, 'Local Reading Fixture', 'Most recently updated first');
    assert.equal(three[0].href, viewerUrl(urn));
    assert(three[0].meta.includes(await message('libraryKindLocalPdf')));
    assert(three[0].meta.includes(await message('epubHighlightCount', '2')));
    console.log('PASS the side panel opens the library, which lists the imported PDF');

    // An EPUB imported here opens in the reader; the Library button returns to the list.
    await page.setInputFiles('#file', files.epub);
    await page.waitForSelector('#viewer:not([hidden])');
    assert(await until(async () => /\?book=book-/.test(page.url())), 'The book is imported');
    const bookId = new URL(page.url()).searchParams.get('book');
    await page.click('#library');
    const four = await listed(4);
    assert(four, 'The library lists four documents');
    assert.deepEqual(four.map((item) => item.kind).sort(), ['epub', 'pdf', 'pdf', 'web']);
    const epubItem = byTitle(four, 'A Small Book of Reading');
    assert.equal(epubItem.href, '?book=' + bookId);
    assert(epubItem.meta.includes(await message('libraryKindEpub')));
    console.log('PASS an EPUB imported in the library is listed with the other documents');
    if (shots) await page.screenshot({ path: path.join(shots, 'library.png') });

    // Each document opens where it belongs.
    await page.click(`#books .item[href="${articleUrl}"]`);
    await page.waitForURL(articleUrl);
    assert.equal(await page.title(), 'On Autonomy');
    assert(
      await until(() => page.evaluate(() => CSS.highlights.get('tabgent-highlight')?.size === 1)),
      'The web article restores its highlight',
    );
    await page.goBack();
    await listed(4);
    await page.click('#books .item[data-kind="pdf"] >> text=Online Fixture Paper');
    await viewer();
    assert.equal(page.url(), viewerUrl(onlineUrl));
    assert(await paintedAre(['endorsed']), 'The online PDF restores its highlight');
    await page.goBack();
    await listed(4);
    await page.click('#books .item >> text=Local Reading Fixture');
    await viewer();
    assert.equal(page.url(), viewerUrl(urn));
    assert(await paintedAre([first, second].sort()), 'The imported PDF restores its highlights');
    await page.goBack();
    await listed(4);
    await page.click('#books .item[data-kind="epub"]');
    await page.waitForSelector('#viewer:not([hidden])');
    assert.equal(new URL(page.url()).searchParams.get('book'), bookId);
    assert.equal(await page.title(), 'A Small Book of Reading');
    console.log('PASS web article, online PDF, imported PDF and EPUB each open correctly');

    // After a browser restart the imported PDF reopens from the vault with its highlights.
    await context.close();
    await launch();
    await openLibrary();
    await listed(4);
    await page.click('#books .item >> text=Local Reading Fixture');
    await viewer();
    assert(await paintedAre([first, second].sort()), 'Highlights restored after a restart');
    console.log('PASS restart: the imported PDF reopens from the vault with its highlights');

    // Dropping the same file again reuses its vault copy; another PDF is a new document.
    const drop = (file, name) =>
      page.evaluate(
        async ([base64, name]) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([Uint8Array.fromBase64(base64)], name));
          dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
        },
        [fs.readFileSync(file).toString('base64'), name],
      );
    await openLibrary();
    await listed(4);
    await drop(files.local, 'dropped-copy.pdf');
    await viewer();
    assert.equal(page.url(), viewerUrl(urn));
    assert.equal(fs.readdirSync(books).filter((n) => n.startsWith('paper-')).length, 2);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(books, local, 'source.json'), 'utf8')).name,
      'local-paper.pdf',
    );
    await openLibrary();
    await listed(4);
    await drop(files.untitled, 'untitled-notes.pdf');
    await viewer(1);
    const untitled = await folderOf('paper-untitled-notes-pdf-');
    assert(untitled, fs.readdirSync(books).join());
    assert.equal(anchorsOf(untitled).document.title, 'untitled-notes.pdf');
    await openLibrary();
    await listed(5);
    await drop(files.text, 'notes.txt');
    const refused = await message('libraryNotSupported');
    assert(await until(async () => (await page.textContent('#toast')) === refused));
    assert.equal((await items()).length, 5);
    console.log('PASS drag and drop: the same PDF maps to its vault copy; other files are refused');

    if (shots) fs.writeFileSync(path.join(shots, 'console.txt'), logs.join('\n'));
    assert(!logs.some((line) => line.startsWith('pageerror')), logs.join('\n'));
    assert.equal(personalState(), personalBefore, 'The personal ReadingVault was not touched');
    passed = true;
  } finally {
    await context?.close().catch(() => {});
    server.close();
    const errors = fs.existsSync(temp + '/host.err') && fs.readFileSync(temp + '/host.err', 'utf8');
    if (errors && !passed) console.error(errors.slice(-2000));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
