// The EPUB reader in real Chromium with the real native host. HOME and CODEX_HOME point
// into a temporary folder, so the vault is temporary too, and Codex discovery is disabled:
// no Codex app-server, account, model or real ~/ReadingVault is used.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const extension = path.join(root, 'extension');
const python = process.env.PYTHON || 'python3';
const shots = process.env.EPUB_SHOTS;
const COLOR = 'rgb(255 200 60)';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-epub-'));
  const profile = path.join(temp, 'profile'),
    home = path.join(temp, 'home'),
    codexHome = path.join(temp, 'codex'),
    vault = path.join(home, 'ReadingVault'),
    book = path.join(temp, 'small-book.epub'),
    second = path.join(temp, 'second-book.epub'),
    large = path.join(temp, 'large-book.epub');
  fs.mkdirSync(home);
  const fixture = path.join(extension, 'tests/fixtures/epub_fixture.py');
  for (const args of [[book], [second, 'Second Book'], [large, 'Large Book', '40000000']]) {
    const built = spawnSync(python, [fixture, ...args]);
    assert.equal(built.status, 0, String(built.stderr));
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(book)).digest('hex');
  let context;
  const requests = [],
    logs = [];
  try {
    const key = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).key;
    const id = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')]
      .slice(0, 32)
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join('');
    const connector = path.join(temp, 'connector');
    const shim = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(extension, 'native'))})`,
      'import host',
      'host.executable = lambda: None',
      'host.main()',
    ].join('; ');
    fs.writeFileSync(
      connector,
      `#!/bin/sh\nexport HOME='${home}' CODEX_HOME='${codexHome}'\nexec '${python}' -c '${shim}' "$@"\n`,
      { mode: 0o700 },
    );
    // Chrome reads <user-data-dir>/NativeMessagingHosts, so nothing is installed globally.
    fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'NativeMessagingHosts/com.tabgent.codex.json'),
      JSON.stringify({
        name: 'com.tabgent.codex',
        description: 'Tabgent connector with a temporary home, for tests',
        path: connector,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    const readerUrl = `chrome-extension://${id}/epub/reader.html`;
    let worker, page;
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        viewport: { width: 1200, height: 820 },
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      context.on('request', (request) => requests.push([request.url(), 'sent']));
      context.on('requestfailed', (request) =>
        requests.push([request.url(), request.failure()?.errorText]),
      );
      worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    }
    async function openReader(query = '') {
      page = await context.newPage();
      page.on('console', (message) => logs.push(message.text()));
      page.on('pageerror', (error) => logs.push('pageerror: ' + error.message));
      await page.goto(readerUrl + query);
      return page;
    }
    // Strings follow the browser's UI language (macOS ignores --lang), so compare by key.
    const message = (key, ...args) =>
      page.evaluate(([key, args]) => chrome.i18n.getMessage(key, args), [key, args]);
    const text = async (selector, key) => {
      const expected = await message(key);
      return until(async () => (await page.textContent(selector)) === expected, 20000);
    };
    const chapter = () =>
      until(() => page.frames().find((frame) => frame.url().startsWith('blob:')));
    const chapterTitle = async () => (await chapter()).evaluate(() => document.title);
    // CDP sees foliate's closed shadow roots: count painted highlight groups.
    async function painted() {
      const client = await page.context().newCDPSession(page);
      const { root: document } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      let groups = 0;
      (function walk(node) {
        const attributes = node.attributes || [];
        const at = attributes.indexOf('fill');
        if (node.nodeName === 'g' && at >= 0 && attributes[at + 1] === COLOR) groups++;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
      })(document);
      await client.detach();
      return groups;
    }
    const paintedIs = (count) => until(async () => (await painted()) === count);
    // Opening or closing the contents drawer reflows the book; measure once it is still.
    async function settled() {
      let last = '';
      return until(async () => {
        const frame = await chapter();
        const box = JSON.stringify(await (await frame.frameElement()).boundingBox());
        if (box === last) return frame;
        last = box;
        await wait(150);
      });
    }
    async function textBox(needle, from = 0, to = needle.length) {
      const frame = await settled();
      const box = await frame.evaluate(
        ([needle, from, to]) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode,
              at = node.data.indexOf(needle);
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node, at + from);
            range.setEnd(node, at + to);
            const rects = range.getClientRects(),
              first = rects[0],
              last = rects[rects.length - 1];
            return {
              x1: first.left + 1,
              y1: first.top + first.height / 2,
              x2: last.right - 1,
              y2: last.top + last.height / 2,
            };
          }
          throw Error('Missing chapter text: ' + needle);
        },
        [needle, from, to],
      );
      const owner = await (await frame.frameElement()).boundingBox();
      return {
        x1: owner.x + box.x1,
        y1: owner.y + box.y1,
        x2: owner.x + box.x2,
        y2: owner.y + box.y2,
      };
    }
    async function select(needle) {
      const box = await textBox(needle);
      await page.mouse.move(box.x1, box.y1);
      await page.mouse.down();
      await page.mouse.move(box.x2, box.y2, { steps: 8 });
      await page.mouse.up();
      await page.waitForSelector('#toolbar:popover-open');
    }
    const anchorsFile = () => path.join(vault, 'Books', documentId, 'anchors.json');
    const saved = () => JSON.parse(fs.readFileSync(anchorsFile(), 'utf8'));
    let documentId;

    await launch();
    await openReader();
    await page.waitForSelector('#start:not([hidden])');
    assert(await text('#booksStatus', 'libraryEmpty'), 'Empty vault lists no books');
    await page.setInputFiles('#file', book);
    await page.waitForSelector('#viewer:not([hidden])');
    assert.equal(await page.title(), 'A Small Book of Reading');
    assert(await text('#status', 'epubSaved'), 'Import finished');
    assert.match(page.url(), /\?book=book-a-small-book-of-reading-[0-9a-f]{8}$/);
    documentId = new URL(page.url()).searchParams.get('book');
    const folder = path.join(vault, 'Books', documentId);
    assert.deepEqual(fs.readFileSync(path.join(folder, 'original.epub')), fs.readFileSync(book));
    assert.deepEqual(fs.readdirSync(path.join(folder, 'chapters')), [
      '01-chapter-one-beginnings.md',
      '02-chapter-two-repetition.md',
      '03-chapter-three-endings.md',
    ]);
    console.log('PASS file import renders the book and saves it with chapter files');
    if (shots) await page.screenshot({ path: path.join(shots, 'reader.png') });

    // Book scripts and remote resources are inert.
    const frame = await chapter();
    assert.equal(await chapterTitle(), 'Chapter One: Beginnings');
    assert.deepEqual(
      await frame.evaluate(() => ({
        scripts: [...document.querySelectorAll('script')].map((s) => s.type),
        handlers: document.querySelectorAll('[onclick], [onerror]').length,
        javascript: [...document.links].filter((a) => /^javascript:/i.test(a.href)).length,
      })),
      { scripts: ['application/x-tabgent-disabled'], handlers: 0, javascript: 0 },
    );
    const inert = await textBox('Click handlers must stay inert.');
    await page.mouse.click(inert.x1 + 5, inert.y1);
    assert.equal(await page.evaluate(() => globalThis.tabgentScriptRan), undefined);
    assert.notEqual(await page.title(), 'SCRIPT-RAN');
    // DevTools reports the attempt, and its failure as blocked by the CSP before any network use.
    const remote = requests.filter(([url]) => url.includes('example.invalid'));
    assert(
      remote.some(([, how]) => how === 'csp') &&
        remote.every(([, how]) => ['sent', 'csp'].includes(how)),
      JSON.stringify(remote),
    );
    assert(logs.some((line) => /img-src/.test(line) && line.includes('example.invalid')));
    console.log('PASS EPUB scripts, handlers, javascript: links and remote images are blocked');

    // Highlight: saved with an EPUB anchor and painted.
    await select('independence from others');
    if (shots) await page.screenshot({ path: path.join(shots, 'toolbar.png') });
    await page.click('#highlightAdd');
    await until(() => fs.existsSync(anchorsFile()) && saved().highlights.length === 1);
    const first = saved().highlights[0];
    assert.equal(first.text, 'independence from others');
    assert.equal(first.location, 'Chapter One: Beginnings');
    assert.equal(first.anchor.kind, 'epub');
    assert.match(first.anchor.cfi, /^epubcfi\(\/6\/4!/);
    assert.deepEqual(first.anchor.quote, {
      exact: 'independence from others',
      prefix: 'ginnings Autonomy does not mean ',
      suffix: ', but endorsement of one’s own a',
    });
    assert.deepEqual(first.anchor.chapter, {
      href: 'OEBPS/ch1.xhtml',
      title: 'Chapter One: Beginnings',
      index: 1,
    });
    assert.equal(saved().document.url, 'urn:sha256:' + digest);
    assert(await paintedIs(1), 'Highlight painted');
    console.log('PASS Highlight saves an EPUB anchor (CFI, quote, chapter) and paints it');

    // Ask AI: the side panel opens in the click, then the quote carries the vault record.
    await select('more persistent');
    await page.click('#highlightAsk');
    const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const panels = () =>
      worker.evaluate(
        async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length,
      );
    assert(await until(async () => (await panels()) > 0), 'Ask AI opens the side panel');
    const selection = await until(() =>
      worker.evaluate(async (tabId) => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        return conversations.find(([, s]) => s.tabId === tabId && s.selection?.highlight)?.[1]
          .selection;
      }, tabId),
    );
    assert(selection, 'The tab conversation received the selection');
    assert.equal(selection.text, 'more persistent');
    assert.deepEqual(selection.highlight, { documentId, highlightId: 'h002', kind: 'epub' });
    assert.equal(selection.url, 'urn:sha256:' + digest, 'Quotes name the book by its hash');
    assert.equal(selection.location, 'Chapter One: Beginnings');
    // The tab's conversation is bound to the highlight in this book (reading-companion.js).
    const binding = await worker.evaluate(async (tabId) => {
      const { conversations = [] } = await chrome.storage.session.get('conversations');
      return conversations.find(([, s]) => s.tabId === tabId && s.reading)?.[1].reading;
    }, tabId);
    assert.deepEqual(
      [binding?.url, binding?.kind, binding?.documentId, binding?.highlightId],
      ['urn:sha256:' + digest, 'epub', documentId, 'h002'],
    );
    assert(selection.context.before.endsWith('one’s own actions. People are '));
    assert(selection.context.after.startsWith(' when they endorse what they do.'));
    assert.equal(selection.locator.kind, 'epub');
    assert.equal(selection.locator.documentId, documentId);
    assert.equal(selection.locator.anchor.quote.exact, 'more persistent');
    assert.equal(
      selection.locator.chapterFile,
      path.join(folder, 'chapters/01-chapter-one-beginnings.md'),
    );
    assert.equal(saved().highlights.length, 2);
    assert(await paintedIs(2));
    console.log('PASS Ask AI opens the side panel and hands off highlight, context and locator');

    // Table of contents navigation and highlights in another chapter.
    await page.click('#contentsButton');
    await page.click('#toc button:text-is("Chapter Two: Repetition")');
    assert(await until(async () => (await chapterTitle()) === 'Chapter Two: Repetition'));
    await page.click('#contentsButton');
    await select('独立于他人');
    // A plain selection already names the book and its chapter file, as Ask AI does.
    const plain = await until(() =>
      worker.evaluate(async (tabId) => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        const s = conversations.find(([, s]) => s.tabId === tabId)?.[1];
        return s?.selection?.text === '独立于他人' && s.selection;
      }, tabId),
    );
    assert.equal(plain.locator.documentId, documentId);
    assert.equal(
      plain.locator.chapterFile,
      path.join(folder, 'chapters/02-chapter-two-repetition.md'),
    );
    await page.click('#highlightAdd');
    await until(() => saved().highlights.length === 3);
    assert.equal(saved().highlights[2].location, 'Chapter Two: Repetition');
    assert.equal(saved().highlights[2].anchor.chapter.href, 'OEBPS/ch2.xhtml');
    await select('Repeated line. Shared ending two');
    // Keyboard: Tab moves from the selection into the toolbar, Enter activates.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'highlightAdd');
    await page.keyboard.press('Enter');
    await until(() => saved().highlights.length === 4);
    assert.equal(saved().highlights[3].anchor.quote.exact, 'Repeated line. Shared ending two');
    assert(await paintedIs(2), 'Only this chapter is painted');
    console.log('PASS contents navigation, CJK and repeated-text highlights, keyboard toolbar');

    // Font size and flow are applied to the book and remembered.
    const size = () =>
      chapter().then((frame) =>
        frame.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)),
      );
    const before = await size();
    await page.click('#larger');
    await page.click('#larger');
    assert(await until(async () => (await size()) > before * 1.15), 'Larger text');
    assert.equal(await page.textContent('#fontSize'), '120%');
    await page.click('#flow');
    assert.equal(await page.textContent('#flow'), await message('epubPaginated'));
    assert(await page.isHidden('#next'));
    await page.click('#flow');
    console.log('PASS font size and scrolled/paginated modes');
    if (shots) await page.screenshot({ path: path.join(shots, 'chapter-two.png') });

    // Reopen from the vault: no file picker; position and highlights are restored.
    await wait(600); // The position is saved after a short debounce.
    await page.close();
    await openReader();
    await page.waitForSelector('#books a.item');
    assert.equal(await page.textContent('#books .title'), 'A Small Book of Reading');
    assert(
      (await page.textContent('#books .meta')).includes(await message('epubHighlightCount', '4')),
    );
    if (shots) await page.screenshot({ path: path.join(shots, 'library.png') });
    await page.click('#books a.item');
    await page.waitForSelector('#viewer:not([hidden])');
    assert(await until(async () => (await chapterTitle()) === 'Chapter Two: Repetition'));
    assert(await paintedIs(2), 'Restored highlights are painted');
    assert.equal(await page.textContent('#fontSize'), '120%');
    console.log('PASS library reopens the vault copy at the saved position with highlights');

    // Click a highlight: Ask AI (no discussion yet) and Delete.
    const target = await textBox('独立于他人', 1, 2);
    await page.mouse.click((target.x1 + target.x2) / 2, target.y1);
    await page.waitForSelector('#highlightMenu:popover-open');
    assert.equal(await page.textContent('#menuAsk'), await message('highlightAsk'));
    await page.click('#menuDelete');
    await until(() => saved().highlights.length === 3);
    assert(!saved().highlights.some((h) => h.text === '独立于他人'));
    assert(await paintedIs(1));
    const repeated = await textBox('Shared ending two');
    await page.mouse.click(repeated.x1 + 4, repeated.y1);
    await page.waitForSelector('#highlightMenu:popover-open');
    await page.click('#menuAsk');
    const readerTab = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const reopened = await until(() =>
      worker.evaluate(async (tabId) => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        const s = conversations.find(([, s]) => s.tabId === tabId)?.[1];
        return s?.selection?.highlight?.highlightId === 'h004' && s.selection;
      }, readerTab),
    );
    assert(reopened, 'Ask AI on a saved highlight hands it off');
    assert.equal(reopened.text, 'Repeated line. Shared ending two');
    assert(reopened.context.before.endsWith('Shared ending one. '));
    console.log(
      'PASS clicking a highlight offers Ask AI and Delete; both reach the vault and chat',
    );

    // Restart the browser. A record that no longer matches the text stays unanchored.
    await context.close();
    const data = saved();
    const lost = data.highlights.find((h) => h.text === 'independence from others');
    lost.anchor.quote = { exact: 'words that are not in this book', prefix: '', suffix: '' };
    fs.writeFileSync(anchorsFile(), JSON.stringify(data, null, 2));
    await launch();
    await openReader('?book=' + encodeURIComponent(documentId));
    await page.waitForSelector('#viewer:not([hidden])');
    assert(await until(async () => (await chapterTitle()) === 'Chapter Two: Repetition'));
    assert(await paintedIs(1));
    await page.click('#contentsButton');
    await page.click('#highlightsTab');
    await page.waitForSelector('#highlightList li.unanchored');
    assert.equal(await page.locator('#highlightList li').count(), 3);
    assert.equal(await page.locator('#highlightList li.unanchored').count(), 1);
    assert.equal(await page.locator('#highlightList li.anchored').count(), 2);
    if (shots) await page.screenshot({ path: path.join(shots, 'highlights.png') });
    await page.click('#highlightList li.anchored button >> nth=0');
    assert(await until(async () => (await chapterTitle()) === 'Chapter One: Beginnings'));
    assert(await paintedIs(1), 'The unmatched record is not painted');
    console.log('PASS restart restores highlights; an unmatched record is unanchored, not painted');

    // Dropping the same file again opens it and reuses the vault copy.
    await openReader();
    await page.waitForSelector('#books a.item');
    await page.evaluate(async (base64) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.fromBase64(base64)], 'dropped.epub'));
      dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
    }, fs.readFileSync(book).toString('base64'));
    await page.waitForSelector('#viewer:not([hidden])');
    assert(await text('#status', 'epubSaved'), 'Dropped book import');
    assert.equal(new URL(page.url()).searchParams.get('book'), documentId);
    assert.deepEqual(fs.readdirSync(path.join(vault, 'Books')), [documentId]);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(folder, 'source.json'))).name,
      'small-book.epub',
    );
    console.log('PASS drag and drop opens a book; the same file maps to the same vault book');

    // A newer open supersedes one still loading: the books never mix in state or uploads.
    await openReader();
    await page.waitForSelector('#books a.item');
    await page.setInputFiles('#file', large);
    await page.evaluate(async (base64) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.fromBase64(base64)], 'second-book.epub'));
      dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
    }, fs.readFileSync(second).toString('base64'));
    assert(await text('#status', 'epubSaved'), 'The second book is imported');
    await wait(3000); // Let a superseded open reach its next step.
    assert.equal(await page.title(), 'Second Book');
    assert.equal(await page.locator('#toc button').count(), 4);
    const books = fs.readdirSync(path.join(vault, 'Books')).sort();
    assert.equal(books.length, 2, books.join());
    assert(books.includes(documentId) && books.some((name) => name.startsWith('book-second')));
    assert.match(page.url(), /\?book=book-second-book-/);
    const uploads = path.join(vault, '.tabgent/uploads');
    assert.deepEqual(fs.existsSync(uploads) ? fs.readdirSync(uploads) : [], []);
    console.log('PASS a second open supersedes a loading book; only that book is shown and saved');

    // A non-EPUB drop is refused without cancelling a book that is opening, and returning
    // to the library leaves no loading status behind.
    await page.setInputFiles('#file', large);
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['plain text'], 'notes.txt'));
      dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
    });
    assert(await text('#toast', 'libraryNotSupported'), 'The text file is refused');
    assert(await until(async () => (await page.title()) === 'Large Book', 20000));
    await page.click('#library');
    await page.waitForSelector('#start:not([hidden])');
    assert.equal(await page.textContent('#status'), '');
    await wait(1000);
    assert.equal(await page.textContent('#status'), '', 'A stale import does not report here');
    console.log('PASS non-EPUB drops keep the opening book; the library shows no stale status');

    assert(!logs.some((line) => line.startsWith('pageerror')), logs.join('\n'));
  } catch (error) {
    console.error(logs.join('\n'));
    throw error;
  } finally {
    await context?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
