const assert = require('node:assert/strict'),
  path = require('path'),
  { chromium } = require('playwright');
const article = (before = '', after = '') => `
  <main>
    ${before}
    <h1>Intrinsic motivation</h1>
    <p id="a">Autonomy does not mean independence from others, but endorsement of one's own actions.</p>
    <p id="b">People are <em>more persistent</em> when they endorse what they do.</p>
    <script>var hidden = "Autonomy does not mean";</script>
    <p id="c">Repeated line. Shared ending one.</p>
    <p id="d">Repeated line. Shared ending two.</p>
    ${after}
  </main>`;
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    async function load(html) {
      await page.setContent(html);
      await page.addScriptTag({ path: path.resolve(__dirname, '../web-anchor.js') });
      await page.evaluate(() => {
        // Finds `needle` inside one text node; `nth` selects among repeated matches.
        globalThis.find = (needle, nth = 0) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let seen = 0;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            for (
              let at = node.data.indexOf(needle);
              at !== -1;
              at = node.data.indexOf(needle, at + 1)
            )
              if (seen++ === nth) return { node, at };
          }
          throw Error('Missing fixture text: ' + needle);
        };
        globalThis.rangeOf = (needle, nth = 0) => {
          const { node, at } = find(needle, nth),
            range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          return range;
        };
        globalThis.restore = (anchor) => {
          const result = tabgentWebAnchor.resolve(anchor);
          return result && { method: result.method, text: result.range.toString() };
        };
      });
    }
    const describe = (expression) => page.evaluate(`tabgentWebAnchor.describe(${expression})`);
    const restore = (anchor) => page.evaluate((a) => restore(a), anchor);

    await load(article());
    const anchor = await describe(`rangeOf('independence from others')`);
    assert.equal(anchor.kind, 'web');
    assert.equal(anchor.quote.exact, 'independence from others');
    assert.equal(anchor.quote.prefix, 'motivation Autonomy does not mean '.slice(-32));
    assert.equal(anchor.quote.suffix, ", but endorsement of one's own actions.".slice(0, 32));
    assert.equal(anchor.position.end - anchor.position.start, anchor.quote.exact.length);
    assert.match(anchor.dom.start.path, /p:nth-child\(\d+\) > text\(\)\[0\]$/);
    assert.deepEqual(await restore(anchor), {
      method: 'dom',
      text: 'independence from others',
    });
    const text = await page.evaluate(() => tabgentWebAnchor.buildIndex().text);
    assert(!text.includes('var hidden'), 'Script text is not part of the page text');
    assert(text.startsWith('Intrinsic motivation Autonomy'), 'Block boundaries become one space');
    console.log('PASS anchor shape / prefix and suffix / DOM hint restore / script exclusion');

    // A selection crossing paragraphs and inline markup, ending at an element boundary.
    const crossing = await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(find('endorsement').node, find('endorsement').at);
      range.setEnd(document.querySelector('#b'), 1);
      return tabgentWebAnchor.describe(range);
    });
    assert.equal(crossing.quote.exact, "endorsement of one's own actions. People are");
    const crossingWhole = await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#b'));
      return tabgentWebAnchor.describe(range);
    });
    assert.equal(
      crossingWhole.quote.exact,
      'People are more persistent when they endorse what they do.',
    );
    assert.equal((await restore(crossingWhole)).text, crossingWhole.quote.exact);
    console.log('PASS cross-element and element-boundary selections normalize and restore');

    // Same text with different formatting whitespace keeps positions stable.
    await load(article().replace(/\n\s*/g, ''));
    assert.deepEqual(await restore({ ...anchor, dom: undefined }), {
      method: 'position',
      text: 'independence from others',
    });
    await load(
      article()
        .replace(/<p id="a">/, '<div class="wrap"><p id="a">')
        .replace('actions.</p>', 'actions.</p></div>'),
    );
    assert.equal((await restore(anchor)).text, 'independence from others');
    console.log('PASS minified markup and wrapper changes restore by verified position');

    // Content inserted above: DOM hint and position both fail verification.
    await load(article('<p>Breaking: a new banner was inserted above the article.</p>'));
    assert.deepEqual(await restore(anchor), { method: 'quote', text: 'independence from others' });
    const shifted = await page.evaluate(
      (a) => tabgentWebAnchor.buildIndex().text.slice(a.position.start, a.position.end),
      anchor,
    );
    assert.notEqual(shifted, anchor.quote.exact);
    console.log('PASS changed page: stale DOM hint and position fall back to quote search');

    // Repeated quote: context identifies the right occurrence after the page changed.
    await load(article());
    const second = await describe(`rangeOf('Repeated line.', 1)`);
    assert.equal(second.quote.suffix.startsWith(' Shared ending two.'), true);
    await load(article('<p>Inserted paragraph shifts every offset.</p>'));
    const found = await page.evaluate((a) => {
      const result = tabgentWebAnchor.resolve(a);
      return {
        method: result.method,
        inD: document.querySelector('#d').contains(result.range.startContainer),
      };
    }, second);
    assert.deepEqual(found, { method: 'quote', inD: true });
    console.log('PASS repeated quote resolves by surrounding context');

    // Identical passages with identical context are ambiguous unless position clearly decides.
    const twin =
      '<p>Same words here. Same context.</p><p>Filler between twins.</p><p>Same words here. Same context.</p>';
    await load(`<main>${twin}</main>`);
    const original = await describe(`rangeOf('Same words here.', 1)`);
    const twinAnchor = {
      ...original,
      dom: undefined,
      quote: { ...original.quote, prefix: '', suffix: '' },
    };
    await load(`<main><p>Shift.</p>${twin}</main>`);
    assert.equal(
      await restore({ ...twinAnchor, position: undefined }),
      null,
      'Duplicates without context or position stay unanchored',
    );
    const twins = await page.evaluate(() => {
      const text = tabgentWebAnchor.buildIndex().text,
        first = text.indexOf('Same words here.');
      return [first, text.indexOf('Same words here.', first + 1)];
    });
    const chosen = await page.evaluate((a) => {
      const result = tabgentWebAnchor.resolve(a);
      return result && { method: result.method, start: result.start };
    }, twinAnchor);
    assert.deepEqual(chosen, { method: 'position-tiebreak', start: twins[1] });
    const middle = Math.round((twins[0] + twins[1]) / 2);
    assert.equal(
      await restore({ ...twinAnchor, position: { start: middle, end: middle + 16 } }),
      null,
      'Comparable distances are ambiguous',
    );
    console.log('PASS ambiguous duplicates stay unanchored; only a clearly closer twin is chosen');

    // Removed or rewritten text never highlights something else.
    await load(article().replace('independence from others', 'isolation'));
    assert.equal(await restore(anchor), null);
    await load(article());
    const short = await describe(`rangeOf('persistent')`);
    await load('<main><p>Nothing in common here, but persistent appears once.</p></main>');
    assert.equal(await restore(short), null, 'Short quote with unrelated context is not trusted');
    console.log('PASS removed passage and short quote with changed context stay unanchored');

    // An edited quote is accepted only when it is near-identical and bracketed by its context.
    await load(article());
    const sentence = await describe(
      `rangeOf("Autonomy does not mean independence from others, but endorsement of one's own actions.")`,
    );
    await load(article().replace('independence from others', 'independance from others'));
    const fuzzy = await restore(sentence);
    assert.equal(fuzzy.method, 'fuzzy');
    assert.equal(
      fuzzy.text,
      "Autonomy does not mean independance from others, but endorsement of one's own actions.",
    );
    await load(
      article().replace(
        'Autonomy does not mean independence from others',
        'Something else entirely is written here now',
      ),
    );
    assert.equal(await restore(sentence), null, 'A heavily rewritten passage stays unanchored');
    await load(article().replace('independence', 'inde\u00adpen\u200bdence'));
    assert.equal((await restore(anchor)).text, 'inde\u00adpen\u200bdence from others');
    console.log('PASS small edits match fuzzily; rewrites do not; soft hyphens are ignored');

    const unit = await page.evaluate(() => {
      const { matchQuote, similarity } = tabgentWebAnchor;
      const text = 'alpha beta gamma. alpha beta delta.';
      return {
        unique: matchQuote('one two three four', {
          exact: 'two',
          prefix: 'one ',
          suffix: ' three',
        }),
        context: matchQuote(text, { exact: 'alpha beta', prefix: 'gamma. ', suffix: ' delta.' }),
        empty: matchQuote(text, { exact: '' }),
        similarity: similarity('kitten', 'sitting'),
      };
    });
    assert.equal(unit.unique.start, 4);
    assert.equal(unit.context.start, 18);
    assert.equal(unit.empty, null);
    assert(unit.similarity > 0.5 && unit.similarity < 0.6);
    console.log('PASS quote matcher units');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
