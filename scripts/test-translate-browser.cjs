// Hover translation in real Chromium with the source extension and source connector: a
// webpage, the PDF.js viewer and the EPUB reader. One headless Chrome for Testing (Playwright's new headless
// mode, with a mock keychain); a temporary profile, HOME and CODEX_HOME. Codex is the fixture
// app-server, which answers "译文：<text>" in three deltas: no account, model or network.
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
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const article = `<!doctype html><title>Translation fixture</title>
  <style>body { font: 20px/1.6 Georgia, serif; max-width: 640px; margin: 120px auto }</style>
  <h1>Hover translation</h1>
  <p id="en">Reading slowly gives the mind time to connect new ideas with old ones.</p>
  <p id="other">Short daily sessions build a durable habit for most readers.</p>
  <p id="zh">慢慢阅读能让大脑有时间把新想法和旧想法联系起来。</p>
  <p id="hold">[translate-hold] This translation waits until it is cancelled.</p>
  <div style="height: 1500px"></div>`;
const pdfBytes = textPdf(
  [
    ['Chapter 1. Slow reading', 'Careful readers return to difficult passages.'],
    ['Chapter 2. Motivation', 'Readers who endorse a goal persist for longer.'],
  ],
  { title: 'Translation PDF Fixture', author: 'Fixture Author' },
);

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-translate-'));
  const profile = path.join(temp, 'profile');
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/paper.pdf')) {
      response.setHeader('content-type', 'application/pdf');
      return void response.end(pdfBytes);
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(article);
  });
  let context,
    passed = false;
  try {
    const key = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).key;
    const id = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')]
      .slice(0, 32)
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join('');
    const home = path.join(temp, 'home'),
      codexHome = path.join(home, 'codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
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
        description: 'Tabgent connector for hover translation tests',
        path: connector,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    // Every request the translator made, in order (the fixture appends them).
    const requests = () => {
      const file = path.join(codexHome, 'fixture-translations.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };
    const asked = (text) =>
      requests().filter((r) => r.method === 'turn/start' && r.params.input[0].text === text).length;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      viewport: { width: 1100, height: 800 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--remote-debugging-port=0',
        '--use-mock-keychain',
      ],
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const message = (key, ...args) =>
      worker.evaluate(([key, args]) => chrome.i18n.getMessage(key, args), [key, args]);

    // CDP reads the closed shadow roots (and the PDF.js frame); page scripts cannot.
    async function inShadow(page, hostName, fn) {
      const client = await page.context().newCDPSession(page);
      try {
        const { root: document } = await client.send('DOM.getDocument', {
          depth: -1,
          pierce: true,
        });
        let shadow = null;
        (function walk(node) {
          if (node.localName === hostName && node.shadowRoots?.[0]) shadow = node.shadowRoots[0];
          for (const child of [
            ...(node.children || []),
            ...(node.shadowRoots || []),
            ...(node.contentDocument ? [node.contentDocument] : []),
          ])
            walk(child);
        })(document);
        if (!shadow) return null;
        const { object } = await client.send('DOM.resolveNode', {
          backendNodeId: shadow.backendNodeId,
        });
        const { result } = await client.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          returnByValue: true,
          functionDeclaration: fn,
        });
        return result.value;
      } finally {
        await client.detach();
      }
    }
    const card = (page) =>
      inShadow(
        page,
        'tabgent-translation',
        `function () {
          const card = this.querySelector('.card'), r = card.getBoundingClientRect();
          return { hidden: card.hidden, status: card.dataset.status,
            text: this.querySelector('.text').textContent,
            problem: this.querySelector('.problem').textContent,
            rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
        }`,
      );
    const toolbar = (page) =>
      inShadow(
        page,
        'tabgent-reader',
        `function () {
          const bar = this.querySelector('.bar[role="toolbar"]'), r = bar.getBoundingClientRect();
          return { hidden: bar.hidden, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
        }`,
      );
    const shown = async (page) => {
      const value = await card(page);
      return value && !value.hidden ? value : null;
    };
    const overlaps = (a, b) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    async function drag(page, selector, frame = page, offset = { x: 0, y: 0 }) {
      const box = await frame.evaluate((selector) => {
        const element = document.querySelector(selector);
        const range = document.createRange();
        range.selectNodeContents(element);
        const r = range.getBoundingClientRect();
        return { left: r.left, right: r.right, y: r.top + r.height / 2 };
      }, selector);
      await page.mouse.move(offset.x + box.left + 1, offset.y + box.y);
      await page.mouse.down();
      await page.mouse.move(offset.x + box.right - 2, offset.y + box.y, { steps: 8 });
      await page.mouse.up();
      return { x: offset.x + box.right - 2, y: offset.y + box.y };
    }

    const page = await context.newPage();
    await page.goto(base + '/article');
    await page.waitForLoadState('load');
    await wait(800);

    // Select English and keep the pointer there: the card shows the streamed translation.
    const english = 'Reading slowly gives the mind time to connect new ideas with old ones.';
    const rest = await drag(page, '#en');
    const loading = await until(() => shown(page), 4000);
    assert(loading, 'The card opens after the pointer rests on the selection');
    const done = await until(async () => {
      const value = await shown(page);
      return value?.status === 'done' && value;
    });
    assert(done, 'The translation finishes');
    assert.equal(done.text, '译文：' + english);
    assert.equal(asked(english), 1);
    const settings = requests().find((r) => r.method === 'thread/start').params;
    assert.equal(settings.ephemeral, true);
    assert.equal(settings.model, 'gpt-6-luna');
    const turn = requests().find(
      (r) => r.method === 'turn/start' && r.params.input[0].text === english,
    );
    assert.equal(turn.params.effort, 'low');
    // The usual toolbar is still there, and the card does not cover it.
    const bar = await toolbar(page);
    assert.equal(bar.hidden, false, 'The selection toolbar stays');
    assert(!overlaps(done.rect, bar.rect), JSON.stringify({ card: done.rect, bar: bar.rect }));
    console.log('PASS resting on an English selection streams its translation beside the toolbar');

    // Moving away closes the card; resting again shows the cached translation, no new request.
    await page.mouse.move(40, 700, { steps: 4 });
    assert(await until(async () => !(await shown(page)), 2000), 'Leaving the selection closes it');
    await page.mouse.move(rest.x - 30, rest.y, { steps: 3 });
    const again = await until(async () => {
      const value = await shown(page);
      return value?.status === 'done' && value;
    }, 4000);
    assert.equal(again?.text, '译文：' + english);
    assert.equal(asked(english), 1, 'A repeated hover uses the cached translation');
    // Escape closes it too.
    await page.keyboard.press('Escape');
    assert(await until(async () => !(await shown(page)), 2000), 'Escape closes the card');
    console.log('PASS leaving or Escape closes the card; hovering again uses the cache');

    // Chinese text is not translated.
    const before = requests().length;
    await drag(page, '#zh');
    await wait(1800);
    assert.equal(await shown(page), null, 'A Chinese selection opens no card');
    assert.equal(requests().length, before, 'and sends nothing');
    console.log('PASS a Chinese selection is not translated');

    // A request still running is cancelled when the card closes.
    const hold = await drag(page, '#hold');
    const waiting = await until(() => shown(page), 4000);
    assert.equal(waiting?.status, 'loading');
    assert.equal(waiting.text, await message('translateLoading'));
    await page.mouse.move(hold.x, hold.y + 300, { steps: 3 });
    assert(await until(async () => !(await shown(page)), 2000));
    assert(
      await until(() => requests().some((r) => r.method === 'turn/interrupt'), 4000),
      'Closing the card interrupts the Codex turn',
    );
    console.log('PASS closing the card cancels an unfinished translation');

    // The switch in settings turns it off at once.
    await worker.evaluate(() =>
      chrome.storage.local.set({ hoverTranslate: { enabled: false, delay: 1000 } }),
    );
    await page.mouse.click(40, 760);
    const other = 'Short daily sessions build a durable habit for most readers.';
    await drag(page, '#other');
    await wait(1800);
    assert.equal(await shown(page), null, 'Turned off, nothing opens');
    assert.equal(asked(other), 0);
    await worker.evaluate(() =>
      chrome.storage.local.set({ hoverTranslate: { enabled: true, delay: 500 } }),
    );
    await page.mouse.click(40, 760);
    await drag(page, '#other');
    const quick = await until(async () => {
      const value = await shown(page);
      return value?.status === 'done' && value;
    }, 3000);
    assert.equal(quick?.text, '译文：' + other);
    console.log('PASS the settings switch and hover time apply without a reload');

    // The PDF.js viewer: the same card inside the PDF frame.
    const reader = await context.newPage();
    await reader.goto(base + '/paper.pdf');
    await reader.waitForURL('**/pdf/viewer.html?**');
    await reader.frameLocator('#viewer').locator('.textLayer span').first().waitFor();
    const pdf = reader.frames().find((f) => f.url().includes('/vendor/pdfjs/web/viewer.html'));
    await pdf
      .locator('.page[data-page-number="1"] .textLayer .endOfContent')
      .waitFor({ state: 'attached' });
    await wait(800);
    const line = 'Careful readers return to difficult passages.';
    const span = await pdf.evaluate((line) => {
      const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')];
      const found = spans.find((s) => s.textContent.includes(line));
      found.id = 'tabgent-test-line';
      return !!found;
    }, line);
    assert(span, 'The PDF line is in the text layer');
    const frame = await reader.locator('#viewer').boundingBox();
    const pdfRest = await drag(reader, '#tabgent-test-line', pdf, { x: frame.x, y: frame.y });
    const pdfDone = await until(async () => {
      const value = await shown(reader);
      return value?.status === 'done' && value;
    }, 5000);
    assert.equal(pdfDone?.text, '译文：' + line);
    const pdfBar = await toolbar(reader);
    assert.equal(pdfBar.hidden, false);
    assert(!overlaps(pdfDone.rect, pdfBar.rect), 'The card does not cover the PDF toolbar');
    await reader.mouse.move(pdfRest.x, pdfRest.y + 250, { steps: 3 });
    assert(await until(async () => !(await shown(reader)), 2000), 'Leaving closes it in PDF.js');
    console.log('PASS the PDF.js viewer shows and closes the translation the same way');

    // Translation writes nothing to the reading vault.
    assert.equal(fs.existsSync(path.join(home, 'Tabgent')), false, 'No vault folder was created');
    console.log('PASS translating wrote nothing to the reading vault');

    // The EPUB reader: chapters are frames, and the card sits in the reader page beside them.
    const book = path.join(temp, 'book.epub');
    execSync(`'${python}' '${path.join(extension, 'tests/fixtures/epub_fixture.py')}' '${book}'`);
    const epub = await context.newPage();
    await epub.goto(`chrome-extension://${id}/epub/reader.html`);
    await epub.waitForSelector('#start:not([hidden])');
    await epub.setInputFiles('#file', book);
    await epub.waitForSelector('#viewer:not([hidden])');
    const chapter = await until(() =>
      epub.frames().find((f) => f.url() === 'about:srcdoc' && !f.isDetached()),
    );
    await wait(1200);
    const needle = 'Autonomy does not mean independence from others';
    const box = await chapter.evaluate((needle) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode,
          at = node.data.indexOf(needle);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        const rects = range.getClientRects();
        const first = rects[0],
          last = rects[rects.length - 1];
        return {
          x1: first.left + 1,
          y1: first.top + first.height / 2,
          x2: last.right - 1,
          y2: last.top + last.height / 2,
        };
      }
    }, needle);
    const owner = await (await chapter.frameElement()).boundingBox();
    await epub.mouse.move(owner.x + box.x1, owner.y + box.y1);
    await epub.mouse.down();
    await epub.mouse.move(owner.x + box.x2, owner.y + box.y2, { steps: 8 });
    await epub.mouse.up();
    await epub.waitForSelector('#toolbar:popover-open');
    const bookDone = await until(async () => {
      const value = await shown(epub);
      return value?.status === 'done' && value;
    }, 5000);
    assert(bookDone, 'The card opens over a book chapter');
    assert.match(bookDone.text, /^译文：Autonomy does not mean independence from other/);
    const bookBar = await epub.evaluate(() => {
      const r = document.querySelector('#toolbar').getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    assert(!overlaps(bookDone.rect, bookBar), 'The card does not cover the book toolbar');
    // The card is beside the selection, which is in the chapter frame below it or above it.
    const selectionTop = owner.y + box.y1,
      selectionBottom = owner.y + box.y2;
    assert(
      bookDone.rect.bottom <= selectionTop || bookDone.rect.top >= selectionBottom,
      JSON.stringify({ card: bookDone.rect, selectionTop, selectionBottom }),
    );
    await epub.mouse.move(owner.x + box.x2, owner.y + box.y2 + 260, { steps: 3 });
    assert(await until(async () => !(await shown(epub)), 2000), 'Leaving closes it in a book');
    console.log('PASS the EPUB reader shows the translation beside a chapter selection');
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
