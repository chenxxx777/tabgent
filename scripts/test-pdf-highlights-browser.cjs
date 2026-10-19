// PDF highlights in real Chromium with the source extension and source connector.
// A temporary profile, HOME, and CODEX_HOME isolate the browser, vault, and Codex state;
// no account, model, or personal ReadingVault is used. The PDF is generated fixture text.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { execSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const { textPdf } = require(root + '/extension/tests/fixtures/text-pdf.cjs');
const extension = path.join(root, 'extension');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const fixture = textPdf(
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
  { title: 'Reading Companion Fixture', author: 'Fixture Author' },
);

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-pdf-highlights-'));
  const profile = path.join(temp, 'profile');
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/pdf');
    response.end(fixture);
  });
  let context,
    passed = false;
  try {
    // Chrome reads <user-data-dir>/NativeMessagingHosts, so nothing is installed globally.
    const key = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).key;
    const id = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')]
      .slice(0, 32)
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join('');
    const host = path.join(temp, 'connector');
    const home = path.join(temp, 'home');
    fs.mkdirSync(path.join(home, 'codex'), { recursive: true });
    const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
    fs.writeFileSync(
      host,
      `#!/bin/sh\nexport HOME='${home}' CODEX_HOME='${home}/codex'\nexec '${python}' '${path.join(extension, 'native/host.py')}' "$@" 2>>'${temp}/host.err'\n`,
      { mode: 0o700 },
    );
    fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'NativeMessagingHosts/com.tabgent.codex.json'),
      JSON.stringify({
        name: 'com.tabgent.codex',
        description: 'Tabgent connector for PDF highlight tests',
        path: host,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    const books = path.join(home, 'ReadingVault/Books');
    const docs = () =>
      fs.existsSync(books)
        ? fs.readdirSync(books).map((name) => ({
            name,
            anchors: JSON.parse(fs.readFileSync(path.join(books, name, 'anchors.json'), 'utf8')),
            markdown: fs.readFileSync(path.join(books, name, 'highlights.md'), 'utf8'),
          }))
        : [];
    const saved = () => docs().reduce((n, d) => n + d.anchors.highlights.length, 0);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/papers/companion.pdf?edition=1`;
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
      const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
      // PDF responses are redirected to PDF.js once the extension registers its rule.
      assert(
        await until(() =>
          worker.evaluate(
            async () => (await chrome.declarativeNetRequest.getDynamicRules()).length,
          ),
        ),
      );
      return worker;
    }
    const panels = (worker) =>
      worker.evaluate(
        async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length,
      );
    let page, pdf;
    async function open(hash = '#page=2') {
      page = await context.newPage();
      await page.goto(url + hash);
      await page.waitForURL('**/pdf/viewer.html?**');
      await page.frameLocator('#viewer').locator('.textLayer span').first().waitFor();
      pdf = page.frames().find((f) => f.url().includes('/vendor/pdfjs/web/viewer.html'));
      await pdf.evaluate(() => {
        PDFViewerApplication.page = 2;
      });
      await pdf
        .locator('.page[data-page-number="2"] .textLayer .endOfContent')
        .waitFor({ state: 'attached' });
      await wait(1000);
    }
    const painted = () =>
      pdf.evaluate(() => [...(CSS.highlights.get('tabgent-highlight') || [])].map(String).sort());
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

    let worker = await launch();
    await open();
    assert.equal(docs().length, 0, 'Opening a PDF writes nothing');
    const first = "endorsement of one's own actions";
    await drag(first);
    await press('highlight');
    assert(await until(() => saved() === 1));
    const [doc] = docs();
    assert.match(doc.name, /^paper-reading-companion-fixture-[0-9a-f]{8}$/);
    assert.equal(doc.anchors.document.kind, 'pdf');
    assert.equal(doc.anchors.document.url, url);
    assert.equal(doc.anchors.document.title, 'Reading Companion Fixture');
    const [highlight] = doc.anchors.highlights;
    assert.equal(highlight.text, first);
    assert.match(highlight.location, /^(p\. 2|第 2 页)$/);
    assert.equal(highlight.anchor.kind, 'pdf');
    assert.equal(highlight.anchor.page, 2);
    assert.equal(highlight.anchor.quote.exact, first);
    assert.equal(highlight.anchor.rects[0].page, 2);
    assert.match(doc.markdown, /^type: paper$/m);
    assert.match(doc.markdown, /^author: "Fixture Author"$/m);
    assert(doc.markdown.includes(`> ${first}`), doc.markdown);
    assert(doc.markdown.includes(highlight.location), doc.markdown);
    assert.deepEqual(await until(async () => (await painted()).length && painted()), [first]);
    assert.equal(
      await pdf.evaluate(() => PDFViewerApplication.pdfDocument.annotationStorage.size),
      0,
    );
    console.log('PASS Highlight in PDF.js writes Books/paper-*/ files through the real connector');

    assert.equal(await panels(worker), 0);
    const second = 'independence from other people';
    await drag(second);
    await press('ask');
    assert(await until(() => saved() === 2));
    assert.equal(
      await until(async () => (await panels(worker)) === 1, 5000),
      true,
      'The side panel opens from the click inside the PDF.js frame',
    );
    const selection = await until(() =>
      worker.evaluate(async () => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        return conversations.map(([, s]) => s.selection).find((s) => s?.highlight) || null;
      }),
    );
    assert.equal(selection.text, second);
    assert.equal(selection.highlight.documentId, doc.name);
    assert.equal(selection.highlight.highlightId, 'h002');
    assert.equal(selection.locator.kind, 'pdf');
    assert.equal(selection.locator.page, 2);
    assert.equal(selection.locator.anchor.quote.exact, second);
    assert.match(selection.context.before, /own actions\. It does not mean $/);
    assert.match(selection.context.after, /^\. Readers who endorse a goal/);
    const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) =>
      t.url.endsWith('/ui/chat.html'),
    );
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    const quote = await until(async () => {
      const reply = new Promise((resolve) =>
        socket.addEventListener('message', (e) => resolve(JSON.parse(e.data)), { once: true }),
      );
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            returnByValue: true,
            expression: `document.getElementById('selection')?.hidden === false && document.getElementById('selectionText').textContent`,
          },
        }),
      );
      return (await reply).result?.result?.value;
    });
    socket.close();
    assert.equal(quote, second);
    console.log('PASS Ask AI opens the side panel in-gesture and hands off the PDF payload');

    await context.close();
    worker = await launch();
    await open('');
    assert.deepEqual(await until(async () => (await painted()).length === 2 && painted()), [
      first,
      second,
    ]);
    const hit = await textPoint('endorsement');
    await page.mouse.click(hit.left + 4, hit.y);
    await wait(300);
    await press('delete');
    assert(await until(() => !docs()[0].markdown.includes(`> ${first}`)));
    assert.deepEqual(
      docs()[0].anchors.highlights.map((h) => h.id),
      ['h002'],
    );
    assert.deepEqual(await until(async () => (await painted()).length === 1 && painted()), [
      second,
    ]);
    console.log('PASS restart restores PDF highlights; delete removes the record and Markdown');
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
