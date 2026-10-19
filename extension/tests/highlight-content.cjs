const assert = require('node:assert/strict'),
  path = require('path'),
  { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    // Local fixture served on an HTTP origin so history navigation behaves like a website.
    await page.route('https://reader.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>Reader fixture</title>
          <style>button { font-size: 40px !important; background: red !important; }
            div { position: static !important; }</style>
          <main style="font: 18px/1.6 serif; width: 600px">
            <h2>Chapter one</h2>
            <p id="saved">A saved sentence that should be restored on load.</p>
            <p id="fresh">Autonomy is endorsement of one's own actions, not independence.</p>
            <p id="other">Another paragraph for asking questions about the text.</p>
            <p><a id="link" href="#anchor">Linked words</a></p>
          </main>`,
      }),
    );
    await page.goto('https://reader.test/article');
    await page.evaluate(() => {
      globalThis.sent = [];
      globalThis.vault = {
        document: { id: 'article-doc', createdAt: '2026-10-20T10:00:00+08:00' },
        highlights: [],
        panelOpened: true,
      };
      const attach = Element.prototype.attachShadow;
      // Test-only access to the closed root; pages cannot reach the isolated world this way.
      Element.prototype.attachShadow = function (init) {
        const root = attach.call(this, init);
        if (this.localName === 'tabgent-reader') globalThis.ui = root;
        return root;
      };
      let next = 1;
      const respond = (message) => {
        const url = location.href.split('#')[0];
        if (message.type === 'highlightResolve')
          return { url, document: vault.document, highlights: vault.highlights };
        if (message.type === 'highlightCreate') {
          const highlight = {
            id: `h00${next++}`,
            text: message.text,
            anchor: message.anchor,
            turnCount: 0,
          };
          vault.highlights.push(highlight);
          return {
            url,
            document: vault.document,
            highlight,
            ...(message.ask ? { panelOpened: vault.panelOpened } : {}),
          };
        }
        if (message.type === 'highlightDelete') {
          if (!vault.highlights.some((h) => h.id === message.highlightId))
            return { error: 'Highlight not found on this page', code: 'not_found' };
          vault.highlights = vault.highlights.filter((h) => h.id !== message.highlightId);
          return { ok: true };
        }
        if (message.type === 'highlightAsk') return { panelOpened: vault.panelOpened };
        return {};
      };
      globalThis.chrome = {
        i18n: { getMessage: (key, values) => (values?.length ? `${key}:${values}` : key) },
        runtime: {
          id: 'test',
          sendMessage: async (message) => {
            sent.push(JSON.parse(JSON.stringify(message)));
            return respond(message);
          },
        },
      };
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../web-anchor.js') });
    await page.addStyleTag({ path: path.resolve(__dirname, '../highlight.css') });
    await page.evaluate(() => {
      const text = document.querySelector('#saved').firstChild,
        range = document.createRange();
      range.setStart(text, 2);
      range.setEnd(text, 16);
      vault.highlights.push(
        {
          id: 'h100',
          text: 'saved sentence',
          anchor: tabgentWebAnchor.describe(range),
          turnCount: 2,
        },
        {
          id: 'h101',
          text: 'Lazy paragraph arrives later.',
          anchor: {
            kind: 'web',
            quote: { exact: 'Lazy paragraph arrives later.', prefix: '', suffix: '' },
            position: { start: 900, end: 929 },
          },
          turnCount: 0,
        },
      );
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../highlight-content.js') });
    const painted = () => page.evaluate(() => CSS.highlights.get('tabgent-highlight').size);
    const lastSent = (type) => page.evaluate((t) => sent.filter((m) => m.type === t).at(-1), type);
    const visible = () =>
      page.evaluate(() =>
        globalThis.ui
          ? [...ui.querySelectorAll('.bar, .toast')]
              .filter((e) => !e.hidden)
              .map((e) => e.getAttribute('aria-label') || e.textContent)
          : [],
      );
    await page.waitForFunction(() => sent.some((m) => m.type === 'highlightStatus'));
    assert.equal(await painted(), 1);
    assert.deepEqual((await lastSent('highlightStatus')).unanchored, ['h101']);
    console.log('PASS restore on load paints anchored highlights and reports unanchored ones');

    await page.evaluate(() =>
      document.querySelector('#other').after(
        Object.assign(document.createElement('p'), {
          textContent: 'Lazy paragraph arrives later.',
        }),
      ),
    );
    await page.waitForFunction(() => CSS.highlights.get('tabgent-highlight').size === 2, null, {
      timeout: 5000,
    });
    assert.deepEqual((await lastSent('highlightStatus')).unanchored, []);
    console.log('PASS late content is anchored by the bounded mutation pass');

    const box = (selector, needle) =>
      page.evaluate(
        ([selector, needle]) => {
          const node = document.querySelector(selector).firstChild,
            at = node.data.indexOf(needle),
            range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          const r = range.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            y: r.top + r.height / 2,
          };
        },
        [selector, needle],
      );
    const button = (action) =>
      page.evaluate((action) => {
        const r = ui
          .querySelector(`.bar:not([hidden]) [data-action="${action}"]`)
          .getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, action);
    async function drag(selector, needle) {
      const b = await box(selector, needle);
      await page.mouse.move(b.left + 1, b.y);
      await page.mouse.down();
      await page.mouse.move(b.right - 1, b.y, { steps: 5 });
      await page.mouse.up();
      await page.waitForFunction(() => globalThis.ui && !ui.querySelector('.bar').hidden);
    }

    await drag('#fresh', 'endorsement of');
    assert.deepEqual(await visible(), ['highlightToolbar']);
    const styles = await page.evaluate(() => {
      const button = ui.querySelector('button'),
        bar = ui.querySelector('.bar');
      return {
        font: getComputedStyle(button).fontSize,
        position: getComputedStyle(bar).position,
        open: document.querySelector('tabgent-reader').matches(':popover-open'),
      };
    });
    assert.deepEqual(styles, { font: '13px', position: 'fixed', open: true });
    const highlight = await button('highlight');
    await page.mouse.click(highlight.x, highlight.y);
    await page.waitForFunction(() => CSS.highlights.get('tabgent-highlight').size === 3);
    const create = await lastSent('highlightCreate');
    assert.equal(create.ask, false);
    assert.equal(create.anchor.quote.exact, 'endorsement of');
    assert.equal(create.location, 'Chapter one');
    assert.equal(create.context, undefined);
    assert.equal(await page.evaluate(() => getSelection().isCollapsed), true);
    assert.deepEqual(await visible(), []);
    console.log(
      'PASS selection toolbar in an isolated top-layer root / Highlight saves and paints',
    );

    const word = await box('#fresh', 'endorsement');
    await page.mouse.click(word.left + 5, word.y);
    await page.waitForFunction(() => !ui.querySelectorAll('.bar')[1].hidden);
    assert.equal(await page.evaluate(() => CSS.highlights.get('tabgent-highlight-active').size), 1);
    const remove = await button('delete');
    await page.mouse.click(remove.x, remove.y);
    await page.waitForFunction(() => CSS.highlights.get('tabgent-highlight').size === 2);
    assert.equal((await lastSent('highlightDelete')).highlightId, 'h001');
    assert.equal((await lastSent('highlightDelete')).documentId, 'article-doc');
    const saved = await box('#saved', 'saved');
    await page.mouse.click(saved.left + 5, saved.y);
    await page.waitForFunction(() => !ui.querySelectorAll('.bar')[1].hidden);
    assert.equal(
      await page.evaluate(() => ui.querySelector('[data-action="discuss"]').textContent),
      'highlightOpen',
      'A highlight with turns offers its discussion',
    );
    const discuss = await button('discuss');
    await page.mouse.click(discuss.x, discuss.y);
    await page.waitForFunction(() => sent.some((m) => m.type === 'highlightAsk'));
    const askSaved = await lastSent('highlightAsk');
    assert.equal(askSaved.highlightId, 'h100');
    assert(askSaved.context.after.startsWith(' that should be restored'));
    const link = await box('#link', 'Linked');
    await page.mouse.click(link.left + 5, link.y);
    assert.deepEqual(await visible(), [], 'Plain clicks and links do not open highlight actions');
    console.log('PASS click hit-testing / popover Delete / open discussion for saved highlight');

    await drag('#other', 'asking questions');
    await page.evaluate(() => (vault.panelOpened = false));
    const ask = await button('ask');
    await page.mouse.click(ask.x, ask.y);
    await page.waitForFunction(() => sent.some((m) => m.type === 'highlightCreate' && m.ask));
    const askCreate = await lastSent('highlightCreate');
    assert.equal(askCreate.anchor.quote.exact, 'asking questions');
    assert(askCreate.context.before.endsWith('Another paragraph for '));
    assert(askCreate.context.after.startsWith(' about the text.'));
    await page.waitForFunction(() => !ui.querySelector('.toast').hidden);
    assert.equal(
      await page.evaluate(() => ui.querySelector('.toast').textContent),
      'highlightOpenPanel',
    );
    console.log('PASS Ask AI creates the highlight with nearby context and reports a closed panel');

    // Keyboard: Tab enters the toolbar, arrows move, Escape returns to the page selection.
    await drag('#other', 'Another paragraph');
    await page.keyboard.press('Tab');
    const focused = () => page.evaluate(() => ui.activeElement?.dataset.action || null);
    assert.equal(await focused(), 'highlight');
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(), 'ask');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal(await focused(), null);
    assert.equal(await page.evaluate(() => getSelection().toString()), 'Another paragraph');
    assert.deepEqual(
      (await visible()).filter((v) => v !== 'highlightOpenPanel'),
      [],
    );
    const creates = () =>
      page.evaluate(() => sent.filter((m) => m.type === 'highlightCreate').length);
    const created = await creates();
    await drag('#fresh', 'Autonomy');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (count) => sent.filter((m) => m.type === 'highlightCreate').length > count,
      created,
    );
    assert.equal((await lastSent('highlightCreate')).anchor.quote.exact, 'Autonomy');
    console.log('PASS keyboard toolbar access / Escape keeps selection / Enter activates');

    await page.evaluate(() => (document.body.style.paddingBottom = '2000px'));
    await drag('#other', 'paragraph for');
    await page.mouse.wheel(0, 40);
    await page.waitForFunction(() => ui.querySelector('.bar').hidden);
    console.log('PASS scrolling dismisses the toolbar');

    const before = await page.evaluate(
      () => sent.filter((m) => m.type === 'highlightResolve').length,
    );
    await page.evaluate(() => {
      vault.highlights = [];
      vault.document = { id: 'article-provisional', createdAt: null };
      history.pushState({}, '', '#/next-article');
      history.pushState({}, '', '/next-article');
    });
    await page.waitForFunction(
      (count) => sent.filter((m) => m.type === 'highlightResolve').length > count,
      before,
    );
    await page.waitForFunction(() => CSS.highlights.get('tabgent-highlight').size === 0);
    console.log('PASS SPA navigation reloads the document and clears old highlights');

    // The new page is unsaved: its provisional ID is replaced by the document a write returns.
    await page.evaluate(() => {
      vault.document = { id: 'article-final', createdAt: '2026-10-20T11:00:00+08:00' };
      document.querySelector('#fresh').scrollIntoView({ block: 'center' });
    });
    assert.equal((await lastSent('highlightStatus')).documentId, null);
    await drag('#fresh', 'not independence');
    const save = await button('highlight');
    await page.mouse.click(save.x, save.y);
    await page.waitForFunction(() => CSS.highlights.get('tabgent-highlight').size === 1);
    const target = await box('#fresh', 'independence');
    await page.mouse.click(target.left + 5, target.y);
    await page.waitForFunction(() => !ui.querySelectorAll('.bar')[1].hidden);
    await page.evaluate(() => (vault.highlights = []));
    const deleteButton = await button('delete');
    await page.mouse.click(deleteButton.x, deleteButton.y);
    await page.waitForFunction(() => CSS.highlights.get('tabgent-highlight').size === 0);
    assert.equal((await lastSent('highlightDelete')).documentId, 'article-final');
    console.log('PASS provisional IDs are replaced by the saved document / deleted elsewhere');

    // A highlight across an inline <script> must settle: unrelated mutations do not re-anchor.
    await page.evaluate(() => {
      const before = Object.assign(document.createElement('p'), {
        id: 'ad-before',
        textContent: 'Text before the ad slot ends here.',
      });
      const slot = document.createElement('div');
      slot.append(Object.assign(document.createElement('script'), { textContent: 'void 0;' }));
      const after = Object.assign(document.createElement('p'), {
        id: 'ad-after',
        textContent: 'Text after the ad slot continues.',
      });
      const clock = Object.assign(document.createElement('p'), { id: 'clock', textContent: '0' });
      document.querySelector('main').append(before, slot, after, clock);
      before.scrollIntoView({ block: 'center' });
    });
    const start = await box('#ad-before', 'ends here.'),
      end = await box('#ad-after', 'Text after');
    await page.mouse.move(start.left + 1, start.y);
    await page.mouse.down();
    await page.mouse.move(end.right - 1, end.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => globalThis.ui && !ui.querySelector('.bar').hidden);
    const across = await button('highlight');
    await page.mouse.click(across.x, across.y);
    await page.waitForFunction(() => CSS.highlights.get('tabgent-highlight').size === 1);
    assert.equal((await lastSent('highlightCreate')).anchor.quote.exact, 'ends here. Text after');
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      globalThis.builds = 0;
      const build = tabgentWebAnchor.buildIndex;
      tabgentWebAnchor.buildIndex = (...args) => (builds++, build(...args));
    });
    for (let tick = 1; tick <= 4; tick++) {
      await page.evaluate((tick) => (document.querySelector('#clock').textContent = tick), tick);
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => builds), 0, 'Unrelated mutations must not re-anchor');
    console.log('PASS highlights across inline scripts settle; unrelated mutations do no work');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
