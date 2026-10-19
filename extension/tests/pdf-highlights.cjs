// PDF.js reading layer in Chromium: toolbar, vault requests, painting and restore.
// A stub background keeps an in-memory vault; the fixture PDFs are generated text.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { textPdf } = require('./fixtures/text-pdf.cjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const meta = { title: 'Reading Companion Fixture', author: 'Fixture Author' };
const first = [
  'Chapter 1. Slow reading',
  'Careful readers return to difficult passages.',
  'They write notes in the margins of each page.',
];
const second = [
  'Chapter 2. Motivation',
  "Autonomy is the endorsement of one's own actions.",
  'It does not mean independence from other people.',
  'Readers who endorse a goal persist for longer.',
];
const third = ['Chapter 3. Practice', 'Short daily sessions build a durable habit.'];
const twin = [
  'Repeated block.',
  "Autonomy is the endorsement of one's own actions.",
  'Block ends.',
];
const versions = {
  original: textPdf([first, second, third], meta),
  // A revised edition at the same URL: one inserted page moves chapter 2 to page 3.
  revised: textPdf([first, ['Preface added in the revised edition.'], second, third], meta),
  // The passage is rewritten and repeated, with identical context, on two other pages.
  ambiguous: textPdf(
    [[...first, ...twin], ['Chapter 2. Motivation', 'This chapter was rewritten.'], twin],
    meta,
  ),
};
const quote = "endorsement of one's own actions";

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-pdf-highlights-'));
  const ext = path.join(temp, 'extension');
  fs.mkdirSync(ext);
  for (const name of ['pdf', 'vendor', '_locales'])
    fs.cpSync('extension/' + name, ext + '/' + name, { recursive: true });
  for (const name of [
    'pdf-routing.js',
    'agent-pointer.js',
    'i18n.js',
    'web-anchor.js',
    'vault-client.js',
    'highlight.css',
  ])
    fs.copyFileSync('extension/' + name, ext + '/' + name);
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json'));
  for (const key of ['action', 'icons', 'side_panel', 'content_scripts']) delete manifest[key];
  manifest.permissions = ['tabs', 'storage', 'declarativeNetRequestWithHostAccess'];
  fs.writeFileSync(ext + '/manifest.json', JSON.stringify(manifest));
  fs.writeFileSync(ext + '/setup.html', '<!doctype html><title>PDF highlight control</title>');
  // The production checks: only the current viewer, and only cleaned PDF anchors.
  fs.writeFileSync(
    ext + '/background.js',
    `import { startPdfRouting, isCurrentPdfSender, pdfCommand } from './pdf-routing.js';
import { cleanPdfAnchor } from './vault-client.js';
startPdfRouting();
const calls = [];
let saved = { document: null, highlights: [], next: 1 };
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.type === 'calls') return void reply(calls);
  if (m.type === 'toViewer') {
    // As reading-companion.js does: worker → the tab's top frame.
    chrome.tabs.sendMessage(m.tabId, m.message, { frameId: 0 }).then(reply, (e) => reply({ error: e.message }));
    return true;
  }
  if (m.type === 'turns') {
    for (const h of saved.highlights) h.turnCount = 2;
    return void reply({});
  }
  if (m.type === 'read') {
    pdfCommand(m.tabId, { action: 'read', page: m.page }).then(reply, (e) => reply({ error: e.message }));
    return true;
  }
  if (!String(m.type).startsWith('highlight')) return;
  (async () => {
    if (!(await isCurrentPdfSender(sender))) throw Error('Stale PDF viewer');
    calls.push(m);
    if (m.type === 'highlightResolve') return { document: saved.document, highlights: saved.highlights };
    if (m.type === 'highlightCreate') {
      const anchor = cleanPdfAnchor(m.anchor);
      if (!anchor) throw Error('Invalid highlight');
      saved.document ||= { id: 'paper-reading-companion-fixture-1a2b3c4d', createdAt: 'now' };
      const highlight = { id: 'h' + String(saved.next++).padStart(3, '0'), text: m.text, anchor,
        location: m.location, turnCount: 0 };
      saved.highlights.push(highlight);
      return { document: saved.document, highlight, ...(m.ask ? { panelOpened: true } : {}) };
    }
    if (m.type === 'highlightDelete') {
      saved.highlights = saved.highlights.filter((h) => h.id !== m.highlightId);
      return { ok: true };
    }
    if (m.type === 'highlightAsk') return { panelOpened: true };
    return {};
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});`,
  );
  let version = 'original';
  const server = http
    .createServer((req, res) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      res.end(versions[version]);
    })
    .listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/paper.pdf?id=7`;
  let browser;
  try {
    browser = await chromium.launchPersistentContext(temp + '/profile', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1000, height: 900 },
      args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext],
      acceptDownloads: true,
    });
    const ctl = await browser.newPage();
    await ctl.goto('chrome-extension://lfbgkeagkfmndclpgmipadggnkoimkee/setup.html');
    for (let i = 0; i < 100; i++) {
      if ((await ctl.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length) break;
      await wait(50);
    }
    const calls = (type) =>
      ctl
        .evaluate(() => chrome.runtime.sendMessage({ type: 'calls' }))
        .then((list) => list.filter((m) => m.type === type));
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('VIEWER', e.message));
    let pdf;
    async function open(hash = '') {
      const resolves = (await calls('highlightResolve')).length;
      await page.goto(url + hash);
      await page.waitForURL('**/pdf/viewer.html?**');
      await page.frameLocator('#viewer').locator('.textLayer span').first().waitFor();
      pdf = page.frames().find((f) => f.url().includes('/vendor/pdfjs/web/viewer.html'));
      assert(await until(async () => (await calls('highlightResolve')).length > resolves));
      await wait(400);
    }
    const painted = () =>
      pdf.evaluate(() =>
        [...(CSS.highlights.get('tabgent-highlight') || [])].map((range) => range.toString()),
      );
    const showPage = async (n) => {
      await pdf.evaluate((n) => {
        PDFViewerApplication.page = n;
      }, n);
      await pdf
        .locator(`.page[data-page-number="${n}"] .textLayer .endOfContent`)
        .waitFor({ state: 'attached' });
      await wait(300);
    };
    async function drag(n, needle) {
      const box = await pdf.evaluate(
        ([n, needle]) => {
          const layer = document.querySelector(`.page[data-page-number="${n}"] .textLayer`);
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
        },
        [n, needle],
      );
      const frame = await page.locator('#viewer').boundingBox();
      await page.mouse.move(frame.x + box.left + 1, frame.y + box.y);
      await page.mouse.down();
      await page.mouse.move(frame.x + box.right - 1, frame.y + box.y, { steps: 8 });
      await page.mouse.up();
      await wait(300);
      return { x: frame.x + (box.left + box.right) / 2, y: frame.y + box.y };
    }
    // CDP sees the toolbar inside the viewer frame's closed shadow root; scripts cannot.
    async function press(action) {
      const client = await page.context().newCDPSession(page);
      const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
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
      })(root);
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId: target });
      await client.detach();
      await page.mouse.click(
        (model.border[0] + model.border[4]) / 2,
        (model.border[1] + model.border[5]) / 2,
      );
      await wait(300);
    }

    await open('#page=2');
    await showPage(2);
    // The text-layer DOM and getTextContent produce the same page text.
    const consistent = await page.evaluate(async () => {
      const anchors = await import('./pdf-anchor.js');
      const app = document.querySelector('#viewer').contentWindow.PDFViewerApplication;
      const results = [];
      for (let n = 1; n <= app.pagesCount; n++) {
        const layer = app.pdfViewer.getPageView(n - 1).textLayer?.div;
        if (!layer?.querySelector('.endOfContent')) continue;
        const content = await (
          await app.pdfDocument.getPage(n)
        ).getTextContent({ includeMarkedContent: true, disableNormalization: true });
        results.push(anchors.layerIndex(layer).text === anchors.pageText(content.items));
      }
      return results;
    });
    assert(consistent.length >= 2 && consistent.every(Boolean), JSON.stringify(consistent));
    console.log('PASS text-layer text matches getTextContent text on every rendered page');

    // Codex reads one page at a time through the browser tool's PDF.js path.
    const tabId = await ctl.evaluate(
      async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id,
      page.url(),
    );
    const read = await ctl.evaluate(
      (tabId) => chrome.runtime.sendMessage({ type: 'read', tabId, page: 3 }),
      tabId,
    );
    assert.equal(read.page, 3);
    assert.equal(read.pages, 3);
    assert.match(read.text, /^Chapter 3\. Practice/);
    assert(!read.text.includes('Motivation'), 'Only the requested page is returned');
    console.log('PASS Codex can read a specific page of the PDF (page 3 of 3)');

    await drag(2, quote);
    assert.equal(
      await pdf.evaluate(() => !!document.querySelector('.editToolbar:not(.hidden)')),
      false,
      'The PDF.js floating highlight button is replaced by the Tabgent toolbar',
    );
    await press('highlight');
    const [created] = await until(async () => {
      const list = await calls('highlightCreate');
      return list.length && list;
    });
    assert.equal(created.ask, false);
    assert.equal(created.text, quote);
    assert.equal(created.title, meta.title);
    assert.equal(created.meta.author, meta.author);
    assert.equal(created.meta.siteName, '127.0.0.1');
    // The page label follows the browser language.
    assert.match(created.location, /^(p\. 2|第 2 页)$/);
    const { anchor } = created;
    assert.equal(anchor.kind, 'pdf');
    assert.equal(anchor.page, 2);
    assert.equal(anchor.endPage, undefined);
    assert.equal(anchor.quote.exact, quote);
    assert.equal(anchor.quote.prefix, 'Chapter 2. Motivation Autonomy is the '.slice(-32));
    assert.equal(anchor.quote.suffix, '. It does not mean independence ');
    assert.deepEqual(anchor.textLayer, { start: 38, end: 38 + quote.length });
    assert.equal(anchor.rects.length, 1, JSON.stringify(anchor.rects));
    const [x1, y1, x2, y2] = anchor.rects[0].pdf;
    // Line 2 of the page: baseline 704pt, Helvetica 12pt, starting after "Autonomy is the ".
    assert(x1 > 140 && x1 < 175 && x2 > 300 && x2 < 360, JSON.stringify(anchor.rects));
    assert(y1 > 695 && y1 < 706 && y2 > 709 && y2 < 722, JSON.stringify(anchor.rects));
    assert.deepEqual(await until(async () => (await painted()).length && painted()), [quote]);
    assert.equal(await pdf.evaluate(() => getSelection().isCollapsed), true);
    assert.equal(
      await pdf.evaluate(() => PDFViewerApplication.pdfDocument.annotationStorage.size),
      0,
      'Vault highlights never touch the PDF annotation storage',
    );
    await page.screenshot({ path: path.join(os.tmpdir(), 'tabgent-pdf-highlight.png') });
    console.log('PASS Highlight saves page, quote, text-layer offsets and PDF rects, then paints');

    // Restore after reload: verified by the saved offsets on the saved page.
    const reportsBefore = (await calls('highlightStatus')).length;
    await open('#page=2');
    await showPage(2);
    assert.deepEqual(await until(async () => (await painted()).length && painted()), [quote]);
    assert(
      (await calls('highlightStatus')).slice(reportsBefore).every((s) => !s.unanchored.length),
      'A highlight is not reported unanchored while it is being restored',
    );
    const status = (await calls('highlightStatus')).at(-1);
    assert.deepEqual(
      { anchored: status.anchored, unanchored: status.unanchored, documentId: status.documentId },
      { anchored: 1, unanchored: [], documentId: 'paper-reading-companion-fixture-1a2b3c4d' },
    );
    // Selecting the same passage again reuses the saved highlight.
    await drag(2, quote);
    await press('highlight');
    assert.equal((await calls('highlightCreate')).length, 1);
    console.log('PASS reload restores the highlight; reselecting it does not duplicate it');

    version = 'revised';
    await open();
    await showPage(3);
    assert.deepEqual(await until(async () => (await painted()).length && painted()), [quote]);
    assert.equal(
      await pdf.evaluate(() =>
        [...CSS.highlights.get('tabgent-highlight')][0].startContainer.parentElement
          .closest('.page')
          .getAttribute('data-page-number'),
      ),
      '3',
    );
    version = 'ambiguous';
    await open();
    await showPage(3);
    await wait(500);
    assert.deepEqual(await painted(), []);
    const unanchored = (await calls('highlightStatus')).at(-1);
    assert.deepEqual([unanchored.anchored, unanchored.unanchored], [0, ['h001']]);
    console.log('PASS moved text re-anchors on its new page; ambiguous text stays unpainted');

    version = 'original';
    await open('#page=2');
    await showPage(2);
    await until(async () => (await painted()).length);
    // Clicking the painted highlight offers Ask AI / Delete.
    const hit = await pdf.evaluate(() => {
      const r = [...CSS.highlights.get('tabgent-highlight')][0].getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2 };
    });
    const frame = await page.locator('#viewer').boundingBox();
    await page.mouse.click(frame.x + hit.x, frame.y + hit.y);
    await wait(300);
    assert.deepEqual(
      await pdf.evaluate(() =>
        [...(CSS.highlights.get('tabgent-highlight-active') || [])].map(String),
      ),
      [quote],
    );
    // The PDF.js find field keeps Tab and Escape while the popover is open.
    await pdf.evaluate(() => PDFViewerApplication.findBar.open());
    await pdf.locator('#findInput').waitFor();
    await page.keyboard.press('Tab');
    assert.notEqual(await pdf.evaluate(() => document.activeElement.localName), 'tabgent-reader');
    await pdf.locator('#findInput').focus();
    await page.keyboard.press('Escape');
    assert.equal(await pdf.evaluate(() => PDFViewerApplication.findBar.opened), false);
    await page.mouse.click(frame.x + hit.x, frame.y + hit.y);
    await wait(300);
    await press('discuss');
    const asked = (await until(async () => (await calls('highlightAsk')).at(-1))) || {};
    assert.equal(asked.highlightId, 'h001');
    assert.equal(asked.documentId, 'paper-reading-companion-fixture-1a2b3c4d');
    assert.match(asked.context.before, /Motivation Autonomy is the $/);
    assert.match(asked.context.before, /^Chapter 1\. Slow reading/, 'Previous page is context');
    assert.match(asked.context.after, /^\. It does not mean independence/);
    await page.mouse.click(frame.x + hit.x, frame.y + hit.y);
    await wait(300);
    await press('delete');
    assert(
      await until(async () => (await calls('highlightDelete')).at(-1)?.highlightId === 'h001'),
    );
    assert.deepEqual(await until(async () => !(await painted()).length && []), []);
    console.log('PASS clicking a highlight opens Ask AI / Delete; delete unpaints it');

    // Ask AI on a new selection hands over the anchor and nearby text.
    await drag(2, 'independence from other people');
    await press('ask');
    const ask = await until(async () => (await calls('highlightCreate')).find((m) => m.ask));
    assert.equal(ask.anchor.quote.exact, 'independence from other people');
    assert.match(
      ask.context.before,
      /Autonomy is the endorsement of one's own actions\. It does not mean $/,
    );
    assert.match(
      ask.context.after,
      /^\. Readers who endorse a goal persist for longer\. Chapter 3/,
    );
    assert.deepEqual(await until(async () => (await painted()).length && painted()), [
      'independence from other people',
    ]);
    console.log('PASS Ask AI creates the highlight with nearby text from this and the next page');

    // The worker's reading companion asks the viewer about its highlights.
    const toViewer = (message) =>
      ctl.evaluate(
        ([tabId, message]) => chrome.runtime.sendMessage({ type: 'toViewer', tabId, message }),
        [tabId, message],
      );
    const id = (await calls('highlightCreate')).find((m) => m.ask) && 'h002';
    const context = await toViewer({
      type: 'tabgentHighlight',
      action: 'context',
      highlightId: id,
    });
    assert.match(context.before, /It does not mean $/);
    assert.match(context.after, /^\. Readers who endorse/);
    assert.equal(
      await toViewer({ type: 'tabgentHighlight', action: 'context', highlightId: 'h404' }),
      null,
    );
    await showPage(3);
    assert.deepEqual(
      await toViewer({ type: 'tabgentHighlight', action: 'jump', highlightId: id }),
      { found: true },
    );
    assert.equal(
      await until(() => pdf.evaluate(() => PDFViewerApplication.page === 2)),
      true,
      'Jump scrolls the highlight page into view',
    );
    assert.deepEqual(
      await until(async () => {
        const active = await pdf.evaluate(() =>
          [...(CSS.highlights.get('tabgent-highlight-active') || [])].map(String),
        );
        return active.length && active;
      }),
      ['independence from other people'],
    );
    assert.deepEqual(
      await toViewer({ type: 'tabgentHighlight', action: 'jump', highlightId: 'h404' }),
      { found: false },
    );
    const resolvesBefore = (await calls('highlightResolve')).length;
    await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'turns' }));
    await toViewer({ type: 'tabgentHighlight', action: 'refresh' });
    assert(await until(async () => (await calls('highlightResolve')).length > resolvesBefore));
    await wait(300);
    assert.deepEqual(await painted(), ['independence from other people']);
    console.log('PASS the worker can ask a PDF viewer for context, jump to a highlight, refresh');

    // A selection across the page break becomes one highlight on both pages.
    await showPage(1);
    await showPage(2);
    await pdf.evaluate(() => {
      const node = (n, text) => {
        const layer = document.querySelector(`.page[data-page-number="${n}"] .textLayer`);
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        while (walker.nextNode())
          if (walker.currentNode.data.includes(text)) return walker.currentNode;
      };
      const range = document.createRange();
      const start = node(1, 'margins');
      range.setStart(start, start.data.indexOf('margins'));
      const end = node(2, 'Motivation');
      range.setEnd(end, end.data.indexOf('Motivation') + 'Motivation'.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await wait(400);
    await press('highlight');
    const spanning = await until(async () =>
      (await calls('highlightCreate')).find((m) => m.anchor.endPage),
    );
    assert.equal(spanning.anchor.page, 1);
    assert.equal(spanning.anchor.endPage, 2);
    assert.equal(spanning.anchor.quote.exact, 'margins of each page. Chapter 2. Motivation');
    assert.match(spanning.location, /^(pp\. 1–2|第 1–2 页)$/);
    assert.deepEqual([...new Set(spanning.anchor.rects.map((r) => r.page))], [1, 2]);
    await open('#page=2');
    await showPage(1);
    await showPage(2);
    assert.deepEqual(
      await until(async () => (await painted()).length === 3 && (await painted()).sort()),
      ['Chapter 2. Motivation', 'independence from other people', 'margins of each page.'],
    );
    console.log('PASS a selection across pages is saved once and restored on both pages');

    // Keyboard: Tab moves from the selection to the toolbar; Escape keeps the selection.
    await drag(2, 'persist for longer');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await wait(300);
    assert.equal(await pdf.evaluate(() => getSelection().toString()), 'persist for longer');
    await drag(2, 'Readers who endorse');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    assert(
      await until(async () =>
        (await calls('highlightCreate')).some(
          (m) => !m.ask && m.anchor.quote.exact === 'Readers who endorse',
        ),
      ),
    );
    assert.equal((await calls('highlightCreate')).length, 4, 'Escape created nothing');
    console.log('PASS keyboard: Tab reaches the toolbar, Escape dismisses, Enter highlights');
  } finally {
    await browser?.close();
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
