// Clipping in real Chromium with the source extension and the real connector. A temporary
// profile, HOME and CODEX_HOME isolate the browser, the vault and Codex state, and Codex is
// the fixture app-server: no account, model or personal ReadingVault is used. Pages are
// generated and served from 127.0.0.1; any other address is refused.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { execSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const extension = path.join(root, 'extension');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const paragraphs = (n, word) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>${word} paragraph ${i + 1}: careful readers return to difficult passages and note what the author argues.</p>`,
  ).join('');
const article = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>On Autonomy</title>
  <meta name="author" content="Fixture Author"><meta property="og:site_name" content="Fixture Essays">
  <style>body { font: 20px/1.6 Georgia, serif; max-width: 680px; margin: 40px auto }</style></head><body>
  <nav><a href="/">Home</a> <a href="/archive">Archive</a></nav>
  <main><article><h1>On Autonomy</h1>
  <p id="a">Autonomy does not mean independence from others, but endorsement of one's own actions.</p>
  ${paragraphs(8, 'Body')}
  <p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/lazy.jpg" alt="Lazy figure" width="640" height="360"></p>
  <p><img src="/img/forbidden.png" alt="Forbidden" width="320" height="200">
    <img src="/img/vector.svg" alt="Vector" width="320" height="200"></p>
  <p>Read the <a href="/notes">notes</a> or <a href="javascript:alert(1)">this</a>.</p>
  <script>window.pageScript = 1</script>
  </article></main><footer>Copyright Fixture Essays</footer></body></html>`;
// The same text on a page that enforces Trusted Types, which the clipping script must survive.
const trusted = article.replace('<title>On Autonomy</title>', '<title>Trusted Types</title>');
// Large images (about 4.5 MB each) whose upload takes several vault requests.
const heavy = `<!doctype html><html><head><meta charset="utf-8"><title>Heavy figures</title></head>
  <body><main><article><h1>Heavy figures</h1>${paragraphs(6, 'Figure')}
  ${[1, 2, 3, 4].map((n) => `<p><img src="/img/big-${n}.png" alt="Big ${n}" width="800" height="600"></p>`).join('')}
  </article></main></body></html>`;
const bigImage = (n) => {
  const bytes = crypto.randomBytes(4.5 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]).copy(bytes);
  return bytes;
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
const short = `<!doctype html><html><head><meta charset="utf-8"><title>Short note</title></head><body>
  <main><p>Only a few words on this page.</p></main><aside>${paragraphs(1, 'Aside')}</aside></body></html>`;

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-clip-'));
  const profile = path.join(temp, 'profile'),
    home = path.join(temp, 'home'),
    codexHome = path.join(home, 'codex'),
    vault = path.join(home, 'ReadingVault'),
    articles = path.join(vault, 'Articles');
  const personal = path.join(os.homedir(), 'ReadingVault');
  const personalState = () => (fs.existsSync(personal) ? fs.statSync(personal).mtimeMs : null);
  const personalBefore = personalState();
  fs.mkdirSync(codexHome, { recursive: true });
  const requested = [];
  const big = new Map([1, 2, 3, 4].map((n) => [`/img/big-${n}.png`, bigImage(n)]));
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/img/lazy.jpg') {
      response.setHeader('content-type', 'image/jpeg');
      return void response.end(JPEG);
    }
    if (pathname === '/img/vector.svg') {
      response.setHeader('content-type', 'image/svg+xml');
      return void response.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    }
    if (big.has(pathname)) {
      response.setHeader('content-type', 'image/png');
      return void response.end(big.get(pathname));
    }
    if (pathname.startsWith('/img/')) {
      response.statusCode = pathname === '/img/forbidden.png' ? 403 : 404;
      return void response.end();
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (pathname === '/trusted')
      response.setHeader('content-security-policy', "require-trusted-types-for 'script'");
    response.end(
      pathname === '/trusted'
        ? trusted
        : pathname === '/short'
          ? short
          : pathname === '/heavy'
            ? heavy
            : article,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context,
    passed = false;
  try {
    const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
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
        description: 'Tabgent connector for clipping tests',
        path: connector,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
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
    // Nothing leaves the machine: only the local fixture server answers.
    const outside = [];
    await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
      outside.push(route.request().url());
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const message = (key, ...args) =>
      worker.evaluate(([key, args]) => chrome.i18n.getMessage(key, args), [key, args]);

    // Selecting text and pressing the reading toolbar, as in the highlight tests.
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
    }
    // CDP sees inside closed shadow roots (the reading toolbar, the clipping prompt).
    async function shadowNodes(page, hostName) {
      const client = await page.context().newCDPSession(page);
      const { root: document } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const found = [];
      (function walk(node, inside) {
        const within = inside || node.localName === hostName;
        if (within) found.push(node);
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])])
          walk(child, within);
      })(document, false);
      return { client, found };
    }
    async function clickIn(page, hostName, match) {
      const { client, found } = await shadowNodes(page, hostName);
      const target = found.find(match);
      assert(target, `No element to click in ${hostName}`);
      const { model } = await client.send('DOM.getBoxModel', {
        backendNodeId: target.backendNodeId,
      });
      await client.detach();
      await page.mouse.click(
        (model.border[0] + model.border[4]) / 2,
        (model.border[1] + model.border[5]) / 2,
      );
    }
    const text = (node) =>
      (node.children || [])
        .map((child) => (child.nodeType === 3 ? child.nodeValue : text(child)))
        .join('');
    async function promptText(page) {
      const { client, found } = await shadowNodes(page, 'tabgent-clip');
      await client.detach();
      const box = found.find((node) => (node.attributes || []).includes('box'));
      return box ? text(box) : '';
    }
    const button = (label) => (node) => node.localName === 'button' && text(node) === label;
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
            const value = JSON.parse(e.data);
            if (value.id !== id) return;
            socket.removeEventListener('message', listen);
            resolve(value);
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
    const folders = () => (fs.existsSync(articles) ? fs.readdirSync(articles) : []);
    const read = (folder, file) => fs.readFileSync(path.join(articles, folder, file), 'utf8');
    const record = (folder) => JSON.parse(read(folder, 'article.json'));

    // A highlight first: its page and the clip are one vault document.
    const page = await context.newPage();
    await page.goto(origin + '/essays/autonomy?id=3#intro');
    await wait(1200);
    await drag(page, '#a', 'independence from others');
    await clickIn(page, 'tabgent-reader', (node) => {
      const at = (node.attributes || []).indexOf('data-action');
      return at >= 0 && node.attributes[at + 1] === 'ask';
    });
    const folder = await until(() => folders()[0]);
    assert(folder, 'The highlight creates the document');
    const panel = await sidePanel();
    // The reading notes menu offers clipping for the web page.
    assert(
      await until(() =>
        panel(
          `(() => { const b = document.getElementById('readingClip'); return b && !b.hidden && b.textContent; })()`,
        ),
      ),
    );
    assert.equal(
      await panel(`document.getElementById('readingClip').textContent`),
      await message('clipPage'),
    );
    const before = requested.length;
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    assert(
      await until(() => fs.existsSync(path.join(articles, folder, 'article.json'))),
      'Clipped',
    );
    assert.deepEqual(folders(), [folder], 'The clip goes into the page folder');
    const markdown = read(folder, 'article.md');
    assert.match(
      markdown,
      new RegExp(
        `^---\\ntitle: "On Autonomy"\\ntype: article-text\\ndocument_id: ${folder}\\nsource: "${origin}/essays/autonomy\\?id=3"\\nauthor: "Fixture Author"\\nsite: "Fixture Essays"\\n`,
      ),
    );
    assert.match(markdown, /Autonomy does not mean independence from others, but endorsement/);
    assert.match(markdown, /Body paragraph 8: careful readers/);
    // The lazy image is saved in assets/; the forbidden and SVG images stay linked online.
    const jpeg = `${crypto.createHash('sha256').update(JPEG).digest('hex').slice(0, 16)}.jpg`;
    assert.match(markdown, new RegExp(`!\\[Lazy figure\\]\\(assets/${jpeg}\\)`));
    assert.deepEqual(fs.readFileSync(path.join(articles, folder, 'assets', jpeg)), JPEG);
    assert.match(markdown, new RegExp(`!\\[Forbidden\\]\\(${origin}/img/forbidden\\.png\\)`));
    assert.match(markdown, new RegExp(`!\\[Vector\\]\\(${origin}/img/vector\\.svg\\)`));
    assert.match(markdown, new RegExp(`\\[notes\\]\\(${origin}/notes\\)`));
    assert.doesNotMatch(markdown, /javascript:|Copyright|Archive|pageScript/);
    const html = read(folder, 'article.html');
    assert.doesNotMatch(html, /<script|javascript:|\ssrc=/);
    assert.match(html, /default-src 'none'/);
    const first = record(folder);
    assert.equal(first.origin.pageUrl, origin + '/essays/autonomy?id=3#intro');
    assert.equal(first.origin.method, 'article');
    assert.deepEqual(first.images, {
      found: 3,
      saved: 1,
      remote: 2,
      failed: [
        { source: `${origin}/img/forbidden.png`, reason: 'http_403' },
        { source: `${origin}/img/vector.svg`, reason: 'not_image' },
      ].sort(
        (a, b) =>
          first.images.failed.findIndex((f) => f.source === a.source) -
          first.images.failed.findIndex((f) => f.source === b.source),
      ),
    });
    assert.deepEqual(
      first.assets.map((asset) => [asset.file, asset.mime]),
      [[`assets/${jpeg}`, 'image/jpeg']],
    );
    const anchors = JSON.parse(read(folder, 'anchors.json'));
    assert.equal(anchors.highlights.length, 1, 'The highlight is kept');
    const savedText = [
      await message('clipSaved', 'On Autonomy', String(first.words)),
      await message('clipImagesSaved', '1'),
      await message('clipImagesFailed', '2'),
    ].join(' ');
    assert(
      await until(async () => (await promptText(page)).includes(savedText)),
      'The page says the clip was saved, with its images',
    );
    // Only the images are fetched, by the worker; the page itself is not loaded again.
    assert.deepEqual([...new Set(requested.slice(before))].sort(), [
      '/img/forbidden.png',
      '/img/lazy.jpg',
      '/img/vector.svg',
    ]);
    assert.match(
      await page.evaluate(() => document.querySelector('img').getAttribute('src')),
      /^data:/,
    );
    // The menu now offers to clip again.
    assert(
      await until(
        async () =>
          (await panel(`document.getElementById('readingClip').textContent`)) ===
          (await message('clipAgain')),
      ),
    );
    console.log(
      'PASS the side panel clips the page and its images into its vault folder; the page is unchanged',
    );

    // Codex can find and read the clipped text with reading_vault.
    const tool = spawnSync(
      python,
      [
        '-c',
        `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import vault
settings = Path(sys.argv[2])
found = vault.tool(settings, {"action": "search", "query": "careful readers paragraph"})
read = vault.tool(settings, {"action": "read", "path": sys.argv[3]})
print(json.dumps([m["path"] for m in found["matches"]][:3] + [read["text"][:2000]]))`,
        path.join(extension, 'native'),
        path.join(codexHome, 'projects/tabgent/vault.json'),
        `Articles/${folder}/article.md`,
      ],
      { env: { ...process.env, HOME: home } },
    );
    assert.equal(tool.status, 0, String(tool.stderr));
    const [hit, , , readText] = JSON.parse(tool.stdout);
    assert.equal(hit, `Articles/${folder}/article.md`);
    assert.match(readText, /Body paragraph 1: careful readers/);
    console.log('PASS reading_vault searches and reads the clipped text');

    // A question about the page carries the article path in its reading context.
    const question = 'What does the essay argue?';
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
    const store = path.join(codexHome, 'fixture-threads.json');
    const sentContext = await until(() => {
      const raw = fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : '';
      return raw.includes(question) && raw.includes('article.md') && raw;
    }, 15000);
    assert(sentContext, 'Codex receives the article path');
    assert(sentContext.includes(path.join(articles, folder, 'article.md')));
    console.log('PASS questions about the page name the clipped article for Codex');

    // Clipping again asks in the page; Replace keeps an article.md the user edited.
    fs.appendFileSync(path.join(articles, folder, 'article.md'), '\nMy own addition.\n');
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    const replaceLabel = await message('clipReplace');
    assert(
      await until(async () => {
        const { client, found } = await shadowNodes(page, 'tabgent-clip');
        await client.detach();
        return found.some(button(replaceLabel));
      }),
      'Asks before replacing',
    );
    await clickIn(page, 'tabgent-clip', button(replaceLabel));
    assert(
      await until(
        () =>
          record(folder).origin.clippedAt !== first.origin.clippedAt ||
          fs.readdirSync(path.join(articles, folder)).some((f) => f.startsWith('article-edited-')),
      ),
    );
    const edited = await until(() =>
      fs.readdirSync(path.join(articles, folder)).find((f) => f.startsWith('article-edited-')),
    );
    assert(edited, 'The edited copy is kept');
    assert.match(read(folder, edited), /My own addition\./);
    assert.doesNotMatch(read(folder, 'article.md'), /My own addition\./);
    console.log('PASS clipping again asks first and keeps an edited article.md');

    // A page that enforces Trusted Types is clipped too (the script runs in its own world).
    await page.goto(origin + '/trusted');
    await wait(800);
    // A test cannot press Chrome's shortcut; the side panel clips through the same path.
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    const trustedFolder = await until(() =>
      folders().find(
        (name) =>
          name.startsWith('article-trusted-types-') &&
          fs.existsSync(path.join(articles, name, 'article.json')),
      ),
    );
    assert(trustedFolder, 'A Trusted Types page is clipped');
    assert.match(read(trustedFolder, 'article.md'), /Body paragraph 3: careful readers/);
    console.log('PASS a page that enforces Trusted Types is clipped');

    // Too little text: the page offers the whole page, which is saved instead.
    await page.goto(origin + '/short');
    await wait(800);
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    const little = await message('clipTooLittle');
    assert(
      await until(async () => (await promptText(page)).startsWith(little)),
      'Offers the whole page',
    );
    await clickIn(page, 'tabgent-clip', button(await message('clipWholePage')));
    const shortFolder = await until(() =>
      folders().find(
        (name) =>
          name.startsWith('article-short-note-') &&
          fs.existsSync(path.join(articles, name, 'article.json')),
      ),
    );
    assert(shortFolder);
    assert.equal(record(shortFolder).origin.method, 'page');
    assert.match(read(shortFolder, 'article.md'), /Only a few words on this page\./);
    console.log('PASS a page with little text can be saved whole');

    // Large images download and upload while the clip runs, one vault request at a time: a
    // highlight made meanwhile in another tab saves within two seconds.
    const other = await context.newPage();
    await other.goto(origin + '/essays/second');
    await wait(1200);
    // The side panel follows the active tab.
    await page.bringToFront();
    await page.goto(origin + '/heavy');
    await wait(1500);
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    // The page shows the image progress while the clip runs.
    const progress = await message('clipSavingImages', '\u0001', '\u0002');
    const running = progress.slice(0, progress.indexOf('\u0001'));
    assert(
      await until(async () => (await promptText(page)).startsWith(running), 20000),
      'The images are being saved',
    );
    const secondFolder = () =>
      folders().find((name) => name.startsWith('article-on-autonomy-') && name !== folder);
    const started = Date.now();
    await other.bringToFront();
    await drag(other, '#a', 'endorsement');
    await clickIn(other, 'tabgent-reader', (node) => {
      const at = (node.attributes || []).indexOf('data-action');
      return at >= 0 && node.attributes[at + 1] === 'highlight';
    });
    assert(await until(() => secondFolder(), 5000), 'The highlight is saved');
    const latency = Date.now() - started;
    assert(latency < 2000, `A highlight waited ${latency} ms during the clip`);
    const heavyFolder = await until(
      () =>
        folders().find(
          (name) =>
            name.startsWith('article-heavy-figures-') &&
            fs.existsSync(path.join(articles, name, 'article.json')),
        ),
      60000,
    );
    assert(heavyFolder, 'The heavy page is clipped');
    assert.equal(record(heavyFolder).assets.length, 4);
    assert.equal(fs.readdirSync(path.join(articles, heavyFolder, 'assets')).length, 4);
    console.log(`PASS a highlight saves in ${latency} ms while a clip saves large images`);

    panel.close();
    assert.deepEqual(outside, [], 'No request left the machine');
    assert.equal(personalState(), personalBefore, 'The personal ReadingVault is untouched');
    passed = true;
  } finally {
    await context?.close().catch(() => {});
    server.close();
    if (!passed && fs.existsSync(path.join(temp, 'host.err')))
      console.error(fs.readFileSync(path.join(temp, 'host.err'), 'utf8').slice(-4000));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
