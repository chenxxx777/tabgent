// EPUB anchors in headless Chromium: build from a selection inside a chapter iframe, restore
// by CFI verified against the quote, fall back to quote search, or stay unanchored. Also
// checks that script neutralization leaves CFIs unchanged. Local files only.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path'),
  { chromium } = require('playwright');
const extension = path.resolve(__dirname, '..');
const harness = `<!doctype html><meta charset="utf-8">
  <script src="/web-anchor.js"></script>
  <script type="module">
    import * as anchor from '/epub/anchor.js';
    import * as CFI from '/vendor/foliate-js/epubcfi.js';
    import { neutralize } from '/epub/book.js';
    globalThis.epub = { anchor, CFI, neutralize };
    document.body.dataset.ready = '1';
  </script>
  <iframe id="chapter"></iframe>`;
const chapter = (extra = '') => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title>
  <script>window.parent.ran = true;</script></head><body>
  <h1>Chapter Two: Repetition</h1>
  <p id="one">Repeated line. Shared ending one.</p>
  <p id="two">Repeated line. Shared ending two.</p>
  ${extra}
  <p>People are <em>more persistent</em> when they endorse what they do.</p>
  <p onclick="window.parent.ran = true">自主性并不意味着独立于他人，而是个体对于自己行为的认同。</p>
  <p><a href="javascript:window.parent.ran = true">link</a> Same twin. Same twin.</p>
</body></html>`;

(async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html');
      return response.end(harness);
    }
    const file = path.join(extension, decodeURIComponent(url.pathname));
    if (!file.startsWith(extension + path.sep) || !fs.existsSync(file)) {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader('content-type', 'text/javascript');
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('body[data-ready]');
    // The reader renders neutralized chapters; load one into the iframe the same way.
    async function load(markup) {
      await page.evaluate((markup) => {
        const clean = epub.neutralize(markup, 'application/xhtml+xml');
        const frame = document.querySelector('#chapter');
        return new Promise((resolve) => {
          frame.onload = resolve;
          frame.src = URL.createObjectURL(new Blob([clean], { type: 'application/xhtml+xml' }));
        });
      }, markup);
      await page.evaluate(() => {
        const doc = document.querySelector('#chapter').contentDocument;
        // Same CFI scheme as foliate's view: spine step, then the chapter path.
        globalThis.cfiOf = (range) =>
          epub.CFI.joinIndir('epubcfi(/6/6)', epub.CFI.fromRange(range));
        globalThis.rangeOfCfi = (cfi) => {
          const parts = epub.CFI.parse(cfi);
          (parts.parent ?? parts).shift();
          return epub.CFI.toRange(doc, parts);
        };
        globalThis.rangeOf = (needle, nth = 0) => {
          const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
          let seen = 0;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            for (
              let at = node.data.indexOf(needle);
              at !== -1;
              at = node.data.indexOf(needle, at + 1)
            )
              if (seen++ === nth) {
                const range = doc.createRange();
                range.setStart(node, at);
                range.setEnd(node, at + needle.length);
                return range;
              }
          }
          throw Error('Missing fixture text: ' + needle);
        };
        // From the start of one text to the end of another, across nodes.
        globalThis.between = (first, last) => {
          const range = doc.createRange();
          const start = rangeOf(first),
            end = rangeOf(last);
          range.setStart(start.startContainer, start.startOffset);
          range.setEnd(end.endContainer, end.endOffset);
          return range;
        };
        globalThis.describe = (range) => {
          const result = epub.anchor.describe(doc, range, {
            cfiOf,
            chapter: { href: 'OEBPS/ch2.xhtml', title: 'Chapter Two: Repetition', index: 2 },
          });
          return result && { ...result, range: result.range.toString() };
        };
        globalThis.restore = (anchor) => {
          const found = epub.anchor.resolve(doc, anchor, { rangeOfCfi });
          return (
            found && { method: found.method, text: found.range.toString(), context: found.context }
          );
        };
      });
    }
    const describe = (expression) => page.evaluate(`describe(${expression})`);
    const restore = (anchor) => page.evaluate((a) => restore(a), anchor);

    await load(chapter());
    assert.equal(await page.evaluate(() => globalThis.ran), undefined, 'Book scripts never run');
    const twin = await describe(`rangeOf('Repeated line. Shared ending two')`);
    assert.equal(twin.range, 'Repeated line. Shared ending two');
    assert.deepEqual(twin.anchor, {
      kind: 'epub',
      cfi: 'epubcfi(/6/6!/4/6[two],/1:0,/1:32)',
      quote: {
        exact: 'Repeated line. Shared ending two',
        prefix: 'peated line. Shared ending one. ',
        suffix: '. People are more persistent whe',
      },
      chapter: { href: 'OEBPS/ch2.xhtml', title: 'Chapter Two: Repetition', index: 2 },
      position: { start: 58, end: 90 },
    });
    assert.ok(twin.context.before.endsWith('Repeated line. Shared ending one. '));
    assert.ok(twin.context.after.startsWith('. People are'));
    assert.deepEqual(await restore(twin.anchor), {
      method: 'cfi',
      text: 'Repeated line. Shared ending two',
      context: twin.context,
    });
    console.log(
      'PASS EPUB anchor: CFI, 32-character quote context, chapter, position; CFI restore',
    );

    // Selections are normalized: surrounding spaces trimmed, inline markup joined.
    const spaced = await describe(`between('two.', ' when ')`);
    assert.equal(spaced.anchor.quote.exact, 'two. People are more persistent when');
    assert.equal((await restore(spaced.anchor)).method, 'cfi');
    const cjk = await describe(`rangeOf('独立于他人')`);
    assert.equal(cjk.anchor.quote.exact, '独立于他人');
    assert.equal((await restore(cjk.anchor)).text, '独立于他人');
    console.log('PASS selections across inline markup and CJK text');

    // A CFI that lands on the same words in another context is only a hint.
    const misplaced = { ...twin.anchor, cfi: 'epubcfi(/6/6!/4/4[one],/1:0,/1:32)' };
    const other = await describe(`rangeOf('Repeated line. Shared ending one')`);
    assert.equal(
      (await restore({ ...other.anchor, cfi: twin.anchor.cfi, quote: { ...other.anchor.quote } }))
        .text,
      'Repeated line. Shared ending one',
    );
    assert.deepEqual((await restore(misplaced)).method, 'quote');
    assert.equal((await restore(misplaced)).text, 'Repeated line. Shared ending two');
    // Broken or foreign CFIs fall back to the quote within the chapter.
    for (const cfi of ['epubcfi(/6/6!/4/40,/1:0,/1:3)', 'not a cfi', '']) {
      const found = await restore({ ...cjk.anchor, cfi });
      assert.equal(found?.text, '独立于他人', cfi);
      assert.equal(found.method, 'quote');
    }
    console.log('PASS CFI verified by quote and context; otherwise quote search in the chapter');

    // Content changed: a passage that cannot be found confidently stays unanchored.
    const lost = {
      ...cjk.anchor,
      cfi: 'epubcfi(/6/6!/4/40,/1:0,/1:3)',
      quote: { exact: 'words that are not in this chapter', prefix: '', suffix: '' },
    };
    assert.equal(await restore(lost), null);
    // Identical twins with identical context and no position cannot be told apart.
    const twins = await describe(`rangeOf('Same twin.', 1)`);
    assert.equal(twins.anchor.quote.exact, 'Same twin.');
    const blind = {
      ...twins.anchor,
      cfi: 'bad',
      quote: { exact: 'Same twin.', prefix: '', suffix: '' },
      position: undefined,
    };
    assert.equal(await restore(blind), null);
    // Its stored position breaks the tie when it is clearly closer to one of them.
    assert.equal(
      (await restore({ ...blind, position: twins.anchor.position })).method,
      'position-tiebreak',
    );
    // A lightly edited passage is still found between its old context.
    await load(chapter().replace('Shared ending two', 'Shared endings two'));
    const edited = await restore({ ...twin.anchor, cfi: 'bad' });
    assert.deepEqual([edited.method, edited.text], ['fuzzy', 'Repeated line. Shared endings two']);
    // An inserted paragraph changes one passage's context and moves the next one's path;
    // the quote search still finds both.
    await load(chapter('<p>An inserted paragraph.</p>'));
    const moved = await restore(twin.anchor);
    assert.deepEqual([moved.method, moved.text], ['quote', 'Repeated line. Shared ending two']);
    const shifted = await restore(cjk.anchor);
    assert.deepEqual([shifted.method, shifted.text], ['quote', '独立于他人']);
    assert.equal(await restore({ kind: 'web', quote: { exact: 'x' } }), null);
    console.log('PASS unconfident matches stay unanchored; ties, edits and moved text are handled');

    // Neutralized markup keeps every element, so CFIs match the original book.
    const result = await page.evaluate(
      (markup) => {
        const original = new DOMParser().parseFromString(markup, 'application/xhtml+xml');
        const cleaned = new DOMParser().parseFromString(
          epub.neutralize(markup, 'application/xhtml+xml'),
          'application/xhtml+xml',
        );
        const cfi = (doc) => {
          const node = [...doc.querySelectorAll('p')].at(-2).firstChild,
            range = doc.createRange();
          range.setStart(node, 2);
          range.setEnd(node, 6);
          return epub.CFI.fromRange(range);
        };
        return {
          same: cfi(original) === cfi(cleaned),
          scripts: [...cleaned.querySelectorAll('script')].map((s) => [s.type, s.textContent]),
          handlers: cleaned.querySelectorAll('[onclick]').length,
          links: [...cleaned.querySelectorAll('a')].map((a) => a.getAttribute('href')),
          refresh: cleaned.querySelectorAll('meta').length,
          html: epub
            .neutralize('<p onmouseover="x()">Hi<script>x()</script></p>', 'text/html')
            .includes('onmouseover'),
        };
      },
      chapter().replace('<head>', '<head><meta http-equiv="refresh" content="0;url=x"/>'),
    );
    assert.deepEqual(result, {
      same: true,
      scripts: [['application/x-tabgent-disabled', '']],
      handlers: 0,
      links: [null],
      refresh: 0,
      html: false,
    });
    console.log('PASS script neutralization removes handlers and scripts without moving CFIs');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
