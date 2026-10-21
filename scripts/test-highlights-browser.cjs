// Webpage highlights in real Chromium with the source extension and source connector.
// A temporary profile, HOME, and CODEX_HOME isolate the browser, vault, and Codex state;
// no account, model, or personal ReadingVault is used.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { execSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const extension = path.join(root, 'extension');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
let prefix = '';
const article = () => `<!doctype html><title>Highlight fixture</title>
  <style>body { font: 20px/1.6 Georgia, serif; max-width: 640px; margin: 40px auto }</style>
  ${prefix}<h1>Intrinsic motivation</h1>
  <p id="a">Autonomy does not mean independence from others, but endorsement of one's own actions.</p>
  <p id="b">People are more persistent when they endorse what they do, and learn more deeply.</p>
  <div style="height: 1500px"></div>`;

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-highlights-'));
  const profile = path.join(temp, 'profile');
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(article());
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
        description: 'Tabgent connector for highlight tests',
        path: host,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    const docs = () => {
      const dir = path.join(temp, 'home/ReadingVault/Articles');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map((name) => ({
        name,
        anchors: JSON.parse(fs.readFileSync(path.join(dir, name, 'anchors.json'), 'utf8')),
        markdown: fs.readFileSync(path.join(dir, name, 'highlights.md'), 'utf8'),
      }));
    };
    const saved = () => docs().reduce((n, d) => n + d.anchors.highlights.length, 0);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        viewport: { width: 1100, height: 800 },
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          '--remote-debugging-port=0',
        ],
      });
      return context.serviceWorkers()[0] || context.waitForEvent('serviceworker');
    }
    const panels = (worker) =>
      worker.evaluate(
        async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length,
      );
    const painted = (page) =>
      page.evaluate(() => CSS.highlights.get('tabgent-highlight')?.size ?? 0);
    async function drag(page, selector, needle) {
      const box = await page.evaluate(
        ([selector, needle]) => {
          const node = document.querySelector(selector).firstChild,
            at = node.data.indexOf(needle),
            range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          const r = range.getBoundingClientRect();
          return { left: r.left, right: r.right, y: r.top + r.height / 2 };
        },
        [selector, needle],
      );
      await page.mouse.move(box.left + 1, box.y);
      await page.mouse.down();
      await page.mouse.move(box.right - 1, box.y, { steps: 6 });
      await page.mouse.up();
      await wait(300);
      return box;
    }
    // CDP can see inside the closed shadow root; page scripts cannot.
    async function button(page, action) {
      const client = await page.context().newCDPSession(page);
      const { root: document } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      let target = null;
      (function walk(node) {
        const attributes = node.attributes || [];
        const at = attributes.indexOf('data-action');
        if (at >= 0 && attributes[at + 1] === action) target = node.backendNodeId;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
      })(document);
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId: target });
      await client.detach();
      return {
        x: (model.border[0] + model.border[4]) / 2,
        y: (model.border[1] + model.border[5]) / 2,
      };
    }
    async function press(page, action) {
      const { x, y } = await button(page, action);
      await page.mouse.click(x, y);
    }
    // The reading layer's closed shadow root, as Markup (CDP pierces it; pages cannot).
    async function layerHtml(page) {
      const client = await page.context().newCDPSession(page);
      const { root: document } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      let shadow = null;
      (function walk(node) {
        if (node.localName === 'tabgent-reader') shadow = node.shadowRoots?.[0];
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
      })(document);
      const { outerHTML } = await client.send('DOM.getOuterHTML', {
        backendNodeId: shadow.backendNodeId,
      });
      await client.detach();
      return outerHTML;
    }
    async function clickText(page, selector, needle) {
      const at = await page.evaluate(
        ([selector, needle]) => {
          const node = document.querySelector(selector).firstChild,
            at = node.data.indexOf(needle),
            range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 4);
          const r = range.getBoundingClientRect();
          return { x: r.left + 3, y: r.top + r.height / 2 };
        },
        [selector, needle],
      );
      await page.mouse.click(at.x, at.y);
      await wait(300);
    }
    const note = '我的看法: endorsement, not independence.';

    let worker = await launch();
    const page = await context.newPage();
    await page.goto(base + '/article?x=1#section');
    await wait(1500);
    assert.equal(docs().length, 0, 'Resolving a page writes nothing');
    assert.equal(await page.evaluate(() => typeof globalThis.tabgentWebAnchor), 'undefined');
    await drag(page, '#a', 'independence from others');
    await press(page, 'highlight');
    assert(await until(() => saved() === 1));
    const [doc] = docs();
    assert.equal(doc.anchors.document.url, base + '/article?x=1');
    assert.equal(doc.anchors.document.title, 'Highlight fixture');
    const [first] = doc.anchors.highlights;
    assert.equal(first.id, 'h001');
    assert.equal(first.text, 'independence from others');
    assert.equal(first.location, 'Intrinsic motivation');
    // The web anchor is stored exactly as the content script built it.
    assert.deepEqual(first.anchor.quote, {
      exact: 'independence from others',
      prefix: 'tivation Autonomy does not mean ',
      suffix: ", but endorsement of one's own a",
    });
    assert.equal(first.anchor.kind, 'web');
    assert.equal(first.anchor.position.end - first.anchor.position.start, 24);
    assert.match(first.anchor.dom.start.path, /p:nth-child\(\d+\) > text\(\)\[0\]$/);
    assert.match(doc.markdown, /^---\ntitle: "Highlight fixture"\n/);
    assert.match(doc.markdown, /<!-- tabgent:highlight h001 start -->/);
    assert.match(doc.markdown, /## Highlight 001\n/);
    assert.match(doc.markdown, /- 位置：Intrinsic motivation\n/);
    assert.match(doc.markdown, /- Anchor ID: h001\n/);
    assert.match(doc.markdown, /\n> independence from others\n/);
    assert.equal(fs.existsSync(path.join(temp, 'home/ReadingVault/AGENTS.md')), true);
    assert.equal(await until(async () => (await painted(page)) === 1), true);
    console.log('PASS isolated content script saves to the vault files and paints a highlight');

    assert.match(
      await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return chrome.sidePanel.open({ tabId: tab.id }).then(
          () => 'opened',
          (e) => e.message,
        );
      }),
      /user gesture/,
    );
    assert.equal(await panels(worker), 0);
    await drag(page, '#b', 'more persistent');
    await press(page, 'ask');
    assert(await until(() => saved() === 2));
    const asked = docs()[0];
    assert.equal(asked.anchors.highlights[1].anchor.quote.exact, 'more persistent');
    assert.match(asked.markdown, /## Highlight 002\n[\s\S]*\n> more persistent\n/);
    assert.equal(await until(async () => (await panels(worker)) === 1, 5000), true);
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
    assert.equal(quote, 'more persistent');
    console.log('PASS Ask AI opens the side panel from the page click and hands off the quote');

    // Only a synchronous call keeps the content-script gesture.
    const tabId = await worker.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
    );
    await worker.evaluate(() => {
      globalThis.probes = {};
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (!message.probe) return;
        const open = () =>
          chrome.sidePanel
            .open({ tabId: sender.tab.id })
            .then(
              () => 'opened',
              () => 'rejected',
            )
            .then((result) => (globalThis.probes[message.probe] = result));
        if (message.probe === 'sync') open();
        if (message.probe === 'microtask') Promise.resolve().then(open);
        if (message.probe === 'api') chrome.tabs.get(sender.tab.id).then(open);
      });
    });
    for (const probe of ['sync', 'microtask', 'api']) {
      await worker.evaluate((tabId) => chrome.sidePanel.close({ tabId }).catch(() => {}), tabId);
      await wait(300);
      await worker.evaluate(
        ([tabId, probe]) =>
          chrome.scripting.executeScript({
            target: { tabId },
            func: (probe) =>
              document.addEventListener('click', () => chrome.runtime.sendMessage({ probe }), {
                once: true,
              }),
            args: [probe],
          }),
        [tabId, probe],
      );
      await page.mouse.click(20, 700);
      await until(() => worker.evaluate((probe) => globalThis.probes[probe], probe), 4000);
    }
    assert.deepEqual(await worker.evaluate(() => globalThis.probes), {
      sync: 'opened',
      microtask: 'rejected',
      api: 'rejected',
    });
    console.log('PASS sidePanel.open keeps the gesture only before the first await');

    // The user's own note: Add note in the popover saves it to anchors.json and highlights.md.
    await clickText(page, '#a', 'independence');
    await press(page, 'note');
    await page.keyboard.type(note);
    await page.keyboard.press('Control+Enter');
    const article = () => docs().find((d) => d.anchors.document.url === base + '/article?x=1');
    assert(await until(() => article().anchors.highlights[0].note === note));
    assert.match(
      article().markdown,
      /\n> independence from others\n\n<!-- tabgent:note h001 start -->\n\n### 笔记\n\n我的看法: endorsement, not independence\.\n\n<!-- tabgent:note h001 end -->\n/,
    );
    assert.equal(article().anchors.highlights[1].note, undefined);
    console.log(
      'PASS a note from the highlight popover is saved to anchors.json and highlights.md',
    );

    // Comment on a selection saves the highlight and the comment together. Cancel stores nothing.
    const beforeComment = article().anchors.highlights.length;
    await drag(page, '#a', "one's own");
    assert.match(
      await layerHtml(page),
      /data-action="highlight"[\s\S]*data-action="comment"[\s\S]*data-action="ask"/,
    );
    await press(page, 'comment');
    await page.keyboard.press('Escape');
    await wait(300);
    assert.equal(article().anchors.highlights.length, beforeComment, 'Escape stores nothing');
    await drag(page, '#a', "one's own");
    await press(page, 'comment');
    await page.keyboard.press('Control+Enter');
    await wait(400);
    assert.equal(
      article().anchors.highlights.length,
      beforeComment,
      'An empty comment stores nothing',
    );
    const emptyHtml = await layerHtml(page);
    assert(
      ['The comment is empty, so nothing was saved.', '评论是空的，未保存。'].some((text) =>
        emptyHtml.includes(text),
      ),
    );
    // The empty-comment toast sits in the top layer; dismiss it before the next selection.
    await page.keyboard.press('Escape');
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await wait(400);
    const comment = 'Deep reading.';
    // The phrase sits on one line; a wrapped range's union box misses the glyphs.
    await drag(page, '#b', 'deeply');
    await press(page, 'comment');
    await page.keyboard.type(comment);
    await page.keyboard.press('Control+Enter');
    assert(await until(() => article().anchors.highlights.length === beforeComment + 1));
    const savedComment = article().anchors.highlights.at(-1);
    assert.equal(savedComment.text, 'deeply');
    assert.equal(savedComment.note, comment);
    assert.match(article().markdown, /### 笔记\n\nDeep reading\./);
    await page.reload();
    assert.equal(await until(async () => (await painted(page)) === beforeComment + 1), true);
    await clickText(page, '#b', 'deeply');
    assert(
      (await layerHtml(page)).includes(`<span>${comment}</span>`),
      'Comment shown after reload',
    );
    await page.keyboard.press('Escape');
    console.log('PASS comment saves the highlight and comment; cancel stores nothing');

    await page.evaluate(() => history.pushState({}, '', '/next?y=2'));
    await wait(1000);
    assert.equal(await painted(page), 0, 'SPA navigation clears the old page highlights');
    await drag(page, '#a', 'endorsement');
    await press(page, 'highlight');
    assert(await until(() => docs().some((d) => d.anchors.document.url === base + '/next?y=2')));
    console.log('PASS SPA navigation saves highlights under the new URL');

    await context.close();
    worker = await launch();
    const restored = await context.newPage();
    await restored.goto(base + '/article?x=1');
    assert.equal(await until(async () => (await painted(restored)) === 3), true);
    prefix = '<p>A banner inserted above the article.</p>';
    await restored.reload();
    assert.equal(await until(async () => (await painted(restored)) === 3), true);
    await restored.evaluate(() => {
      document.querySelector('#b').textContent = 'People are tenacious when they endorse it.';
    });
    assert.equal(await until(async () => (await painted(restored)) === 1), true);
    // Delete through the popover removes the record and its Markdown block.
    const hit = await restored.evaluate(() => {
      const node = document.querySelector('#a').firstChild,
        at = node.data.indexOf('independence'),
        range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 4);
      const r = range.getBoundingClientRect();
      return { x: r.left + 3, y: r.top + r.height / 2 };
    });
    await restored.mouse.click(hit.x, hit.y);
    await wait(300);
    // After a restart, clicking the highlight shows the note above its actions.
    assert((await layerHtml(restored)).includes(`<span>${note}</span>`), 'Note shown on click');
    await press(restored, 'delete');
    assert(
      await until(
        () =>
          !docs()
            .find((d) => d.anchors.document.url === base + '/article?x=1')
            .markdown.includes('independence from others'),
      ),
    );
    assert(!article().markdown.includes(note), 'Deleting the highlight removes its note');
    assert.equal(await until(async () => (await painted(restored)) === 0), true);
    console.log('PASS delete removes the vault record and Markdown block');

    console.log(
      'PASS restart restore / inserted content re-anchors / rewritten text stays unanchored',
    );
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
