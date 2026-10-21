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
  zlib = require('node:zlib'),
  { execSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const extension = path.join(root, 'extension');
const { youtubePage, youtubeCues, json3 } = require(
  path.join(extension, 'tests/fixtures/youtube.cjs'),
);
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
  <meta property="article:published_time" content="2026-08-07"><meta property="og:image" content="/img/cover.png">
  <style>body { font: 20px/1.6 Georgia, serif; max-width: 680px; margin: 40px auto }</style></head><body>
  <nav><a href="/">Home</a> <a href="/archive">Archive</a></nav>
  <main><article><h1>On Autonomy</h1>
  <p id="a">Autonomy does not mean independence from others, but endorsement of one's own actions.</p>
  ${paragraphs(8, 'Body')}
  <p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/lazy.png" alt="Lazy figure" width="640" height="360"></p>
  <p><img src="/img/lazy.png?v=2" alt="Same figure" width="640" height="360"></p>
  <p><img src="/img/hotlinked.png" alt="Protected figure" width="640" height="360"></p>
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
// A real PNG, so the reader can show it.
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x60);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PICTURE = png(32, 18);
// Served only with a Referer, as some image hosts do (anti-hotlinking).
const PROTECTED = png(32, 20);
// A comparison drawn as cards the extractor drops (class "card-content"): the coverage check
// puts it back, the page says so and article.json records it.
const compare = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compared</title></head>
  <body><main><article><h1>Compared</h1>${paragraphs(5, 'Compare')}
  <div class="cards"><div class="card-content"><h3>First approach</h3><p>Reads every page twice and keeps
  the longer copy, which is slow but never loses a paragraph of the text.</p></div>
  <div class="card-content"><h3>Second approach</h3><p>Reads each page once and checks what it kept
  against what the page showed, which is quick and puts back what went missing.</p></div></div>
  ${paragraphs(3, 'After')}</article></main></body></html>`;
const short = `<!doctype html><html><head><meta charset="utf-8"><title>Short note</title></head><body>
  <main><p>Only a few words on this page.</p></main><aside>${paragraphs(1, 'Aside')}</aside></body></html>`;
// The page's cover (og:image), served only with a Referer like the protected image.
const COVER = png(40, 24);
// YouTube watch pages, served at www.youtube.com by the test (nothing reaches YouTube): one
// with captions of its own, one whose captions YouTube does not return.
const VIDEOS = {
  FIXTUREvid1: youtubePage('FIXTUREvid1', {
    tracks: [
      ['en', 'asr', 'English (auto-generated)'],
      ['en', '', 'English'],
    ],
    description: 'A fixture talk.\n\n0:00 Opening\n0:30 Middle\n1:00 End',
  }),
  FIXTUREvid4: youtubePage('FIXTUREvid4', {
    tracks: [['en', 'asr', 'English (auto-generated)']],
    description: 'Show notes of the fixture episode, with guests and links.',
  }),
};
const THUMBNAIL = png(48, 27);
// Only an embedded player: saving the whole page keeps a link, not the page's text.
const video = `<!doctype html><html><head><meta charset="utf-8"><title>Recorded talk</title></head><body>
  <main><h1>Recorded talk</h1><iframe src="/embed/talk" title="Talk"></iframe></main></body></html>`;

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
  const requested = [],
    referers = [];
  const big = new Map([1, 2, 3, 4].map((n) => [`/img/big-${n}.png`, bigImage(n)]));
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    referers.push([request.url, request.headers.referer || '', request.headers.cookie || '']);
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/img/hotlinked.png') {
      if (!request.headers.referer) {
        response.statusCode = 403;
        return void response.end();
      }
      response.setHeader('content-type', 'image/png');
      return void response.end(PROTECTED);
    }
    if (pathname === '/img/cover.png') {
      if (!request.headers.referer) {
        response.statusCode = 403;
        return void response.end();
      }
      response.setHeader('content-type', 'image/png');
      return void response.end(COVER);
    }
    if (pathname === '/img/lazy.png') {
      response.setHeader('content-type', 'image/png');
      return void response.end(PICTURE);
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
            : pathname === '/compare'
              ? compare
              : pathname === '/video'
                ? video
                : pathname === '/embed/talk'
                  ? '<!doctype html><title>Player</title><p>Player</p>'
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
    // Nothing leaves the machine: only the local fixture server answers.
    const outside = [],
      youtubeRequests = [];
    let worker;
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
      await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
        outside.push(route.request().url());
        return route.abort();
      });
      // The fixture YouTube pages, their captions and thumbnails; nothing else of YouTube.
      await context.route(/^https:\/\/(?:www\.youtube\.com|i\.ytimg\.com)\//, (route) => {
        const url = new URL(route.request().url());
        youtubeRequests.push(url.href);
        if (
          url.hostname === 'i.ytimg.com' &&
          /^\/vi\/FIXTUREvid\d\/maxresdefault\.jpg$/.test(url.pathname)
        )
          return route.fulfill({ contentType: 'image/png', body: THUMBNAIL });
        if (url.pathname === '/watch' && VIDEOS[url.searchParams.get('v')])
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: VIDEOS[url.searchParams.get('v')],
          });
        if (
          url.pathname === '/api/timedtext' &&
          url.searchParams.get('v') === 'FIXTUREvid1' &&
          !url.searchParams.get('kind')
        )
          return route.fulfill({
            contentType: 'application/json',
            body: json3(youtubeCues(30, (i) => `Caption sentence ${i + 1} of the talk.`)),
          });
        if (url.pathname === '/api/timedtext') return route.fulfill({ body: '' });
        outside.push(url.href);
        return route.abort();
      });
      worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    }
    await launch();
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
    // The page's cover is saved with its images (with the page's Referer) and named in the
    // front matter; the date is the date the page states.
    const coverFile = `${crypto.createHash('sha256').update(COVER).digest('hex').slice(0, 16)}.png`;
    assert.match(
      markdown,
      new RegExp(
        `\\nsite: "Fixture Essays"\\npublished: "2026-08-07"\\ncover: "assets/${coverFile}"\\n`,
      ),
    );
    assert.deepEqual(fs.readFileSync(path.join(articles, folder, 'assets', coverFile)), COVER);
    // The lazy image is saved in assets/; the forbidden and SVG images stay linked online.
    const picture = `${crypto.createHash('sha256').update(PICTURE).digest('hex').slice(0, 16)}.png`;
    assert.match(markdown, new RegExp(`!\\[Lazy figure\\]\\(assets/${picture}\\)`));
    assert.deepEqual(fs.readFileSync(path.join(articles, folder, 'assets', picture)), PICTURE);
    assert.match(markdown, new RegExp(`!\\[Forbidden\\]\\(${origin}/img/forbidden\\.png\\)`));
    assert.match(markdown, new RegExp(`!\\[Vector\\]\\(${origin}/img/vector\\.svg\\)`));
    assert.match(markdown, new RegExp(`\\[notes\\]\\(${origin}/notes\\)`));
    assert.doesNotMatch(markdown, /javascript:|Copyright|Archive|pageScript/);
    const html = read(folder, 'article.html');
    assert.doesNotMatch(html, /<script|javascript:|\ssrc=/);
    assert.match(html, /default-src 'none'/);
    const first = record(folder);
    // The page's text is all in the clip: the coverage check put nothing back.
    assert.equal(first.coverage.restoredPassages, 0);
    assert(first.coverage.ratio >= 0.95, JSON.stringify(first.coverage));
    assert.equal(first.origin.pageUrl, origin + '/essays/autonomy?id=3#intro');
    assert.equal(first.origin.method, 'article');
    assert.deepEqual(first.cover, {
      source: `${origin}/img/cover.png`,
      file: `assets/${coverFile}`,
    });
    assert.deepEqual(first.metaSources, {
      author: 'metadata',
      publishedAt: 'metadata',
      siteName: 'metadata',
      cover: 'metadata',
    });
    assert.equal(first.contentStatus, 'text');
    assert.equal(first.publishedAt, '2026-08-07');
    assert.deepEqual(first.images, {
      found: 5,
      saved: 3,
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
    // An image its host serves only with a Referer is saved: the worker sends the page's.
    const protectedFile = `${crypto.createHash('sha256').update(PROTECTED).digest('hex').slice(0, 16)}.png`;
    assert.deepEqual(
      first.assets.map((asset) => [asset.file, asset.mime]).sort(),
      [
        [`assets/${picture}`, 'image/png'],
        [`assets/${protectedFile}`, 'image/png'],
        [`assets/${coverFile}`, 'image/png'],
      ].sort(),
    );
    assert.match(markdown, new RegExp(`!\\[Protected figure\\]\\(assets/${protectedFile}\\)`));
    const workerReferers = referers
      .slice(before)
      .filter(([url]) => url === '/img/hotlinked.png')
      .map(([, referer]) => referer);
    // Same origin as the page: the page's address without its fragment, as Chrome sends it.
    assert.deepEqual([...new Set(workerReferers)], [origin + '/essays/autonomy?id=3']);
    assert.deepEqual(
      [
        ...new Set(
          referers
            .slice(before)
            .filter(([url]) => url === '/img/cover.png')
            .map(([, referer]) => referer),
        ),
      ],
      [origin + '/essays/autonomy?id=3'],
    );
    // One file, saved from two addresses: both are recorded.
    assert.deepEqual(
      first.assets.find((asset) => asset.file === `assets/${picture}`).sources.sort(),
      [`${origin}/img/lazy.png`, `${origin}/img/lazy.png?v=2`],
    );
    assert.match(markdown, new RegExp(`!\\[Same figure\\]\\(assets/${picture}\\)`));
    const anchors = JSON.parse(read(folder, 'anchors.json'));
    assert.equal(anchors.highlights.length, 1, 'The highlight is kept');
    const savedText = [
      await message('clipSaved', 'On Autonomy', String(first.words)),
      await message('clipImagesSaved', '3'),
      await message('clipImagesFailed', '2'),
    ].join(' ');
    assert(
      await until(async () => (await promptText(page)).includes(savedText)),
      'The page says the clip was saved, with its images',
    );
    // Only the images are fetched, by the worker; the page itself is not loaded again.
    assert.deepEqual([...new Set(requested.slice(before))].sort(), [
      '/img/cover.png',
      '/img/forbidden.png',
      '/img/hotlinked.png',
      '/img/lazy.png',
      '/img/lazy.png?v=2',
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

    // The page's prompt opens the clipped copy in Tabgent's reader, next to the page.
    const readerPrefix = `chrome-extension://${id}/clip/reader.html?url=`;
    const opening = context.waitForEvent('page');
    await clickIn(page, 'tabgent-clip', button(await message('clipOpen')));
    const reader = await opening;
    assert(await until(() => reader.url().startsWith(readerPrefix)), reader.url());
    assert.equal(reader.url(), readerPrefix + origin + '/essays/autonomy?id=3');
    await reader.waitForSelector('#content p');
    assert.equal(await reader.textContent('#pageTitle'), 'On Autonomy');
    assert.match(await reader.textContent('#byline'), /Fixture Author · Fixture Essays/);
    // The published date as the page states it (not moved to this computer's time zone).
    const publishedText = await reader.evaluate(() =>
      new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }).format(Date.UTC(2026, 7, 7)),
    );
    assert(
      (await reader.textContent('#byline')).includes(
        await message('readingPublished', publishedText),
      ),
      await reader.textContent('#byline'),
    );
    // The cover shows above the text, from the vault.
    assert(
      await until(() =>
        reader.evaluate(() => {
          const cover = document.getElementById('cover');
          return !cover.hidden && cover.src.startsWith('blob:') && cover.naturalWidth === 40;
        }),
      ),
      'The cover is shown',
    );
    assert.equal(await reader.isVisible('#notice'), false);
    // The live page's highlight is painted on the clipped copy.
    const painted = (target) =>
      target.evaluate(() => CSS.highlights.get('tabgent-highlight')?.size ?? 0);
    assert(await until(async () => (await painted(reader)) === 1), 'The highlight is painted');
    // Saved images come from the vault; the others link to their address online.
    assert(
      await until(() =>
        reader.evaluate(() => {
          // Both addresses of the saved image show the vault copy, and the protected image.
          const images = [...document.querySelectorAll('#content img')];
          return (
            images.length === 3 &&
            images.every((img) => img.src.startsWith('blob:') && img.naturalWidth === 32)
          );
        }),
      ),
      'The saved image is shown from the vault',
    );
    assert.deepEqual(
      await reader.$$eval('#content .missing', (items) => items.map((item) => item.href)),
      [`${origin}/img/forbidden.png`, `${origin}/img/vector.svg`],
    );
    // Web links (the page's own and the links to unsaved images) open in a new tab.
    const webLinks = await reader.$$eval('#content a[href^="http"]', (links) =>
      links.map((link) => [link.target, link.rel]),
    );
    assert.equal(webLinks.length, 3);
    assert(webLinks.every(([target, rel]) => target === '_blank' && rel === 'noopener noreferrer'));
    assert.equal(await reader.$$eval('#content a[href^="javascript"]', (l) => l.length), 0);
    console.log('PASS the clipped copy opens offline in the reader with its highlight and image');

    // A highlight made in the reader belongs to the page's document and shows on the page.
    await reader.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#content p')].find((p) =>
        p.textContent.includes('Body paragraph 2'),
      );
      paragraph.id = 'probe';
    });
    await reader.bringToFront();
    // A passage that is unique on the page: repeated passages in identical context are left
    // unanchored in the other view rather than guessed.
    await drag(reader, '#probe', 'paragraph 2: careful readers');
    await clickIn(reader, 'tabgent-reader', (node) => {
      const at = (node.attributes || []).indexOf('data-action');
      return at >= 0 && node.attributes[at + 1] === 'highlight';
    });
    const anchorsOf = () => JSON.parse(read(folder, 'anchors.json'));
    assert(await until(() => anchorsOf().highlights.length === 2), 'Saved from the reader');
    const made = anchorsOf().highlights[1];
    assert.equal(made.text, 'paragraph 2: careful readers');
    assert.equal(made.anchor.view, 'clip');
    assert.equal(anchorsOf().document.url, origin + '/essays/autonomy?id=3');
    await page.bringToFront();
    await page.reload();
    assert(await until(async () => (await painted(page)) === 2), 'Shown on the live page');
    console.log('PASS a highlight made in the reader is saved to the page and shows on it');

    // Ask AI in the reader binds the conversation to the page's highlight.
    await reader.bringToFront();
    await reader.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#content p')].find((p) =>
        p.textContent.includes('Body paragraph 4'),
      );
      paragraph.id = 'probe2';
    });
    await drag(reader, '#probe2', 'paragraph 4: careful readers');
    await clickIn(reader, 'tabgent-reader', (node) => {
      const at = (node.attributes || []).indexOf('data-action');
      return at >= 0 && node.attributes[at + 1] === 'ask';
    });
    assert(await until(() => anchorsOf().highlights.length === 3));
    const asked = await until(() =>
      worker.evaluate(async () => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        return (
          conversations
            .map(([, s]) => s.selection)
            .find((s) => s?.highlight?.highlightId === 'h003') || null
        );
      }),
    );
    assert.equal(asked.url, origin + '/essays/autonomy?id=3');
    assert.equal(asked.highlight.kind, 'web');
    assert.equal(asked.locator.view, 'clip');
    const readerPanel = await sidePanel();
    const readerQuestion = 'What does the clipped passage mean?';
    assert(
      await until(() =>
        readerPanel(`(() => {
          const prompt = document.getElementById('prompt'), button = document.getElementById('send');
          prompt.value = ${JSON.stringify(readerQuestion)};
          prompt.dispatchEvent(new Event('input'));
          if (button.disabled) return false;
          button.click();
          return true;
        })()`),
      ),
    );
    assert(
      await until(() => anchorsOf().turns.some((turn) => turn.highlightId === 'h003'), 15000),
      'The reader turn is saved',
    );
    assert.match(
      read(folder, 'highlights.md'),
      /## Highlight 003[\s\S]*What does the clipped passage mean\?/,
    );
    readerPanel.close();
    console.log('PASS Ask AI in the reader saves the discussion under the page highlight');

    // The reader trusts nothing in the vault: a changed article.html is refused, and markup
    // that also changes the record is cleaned, with no script, remote load, form or frame.
    const htmlPath = path.join(articles, folder, 'article.html'),
      recordPath = path.join(articles, folder, 'article.json');
    const savedHtml = fs.readFileSync(htmlPath),
      savedRecord = fs.readFileSync(recordPath);
    fs.writeFileSync(
      htmlPath,
      savedHtml.toString().replace('<article>', '<article><p>Changed</p>'),
    );
    await reader.reload();
    const incomplete = await message('clipIncomplete');
    assert(await until(async () => (await reader.textContent('#status')).startsWith(incomplete)));
    const evil = `<article>
      <p id="evil">Evil text with <a href="javascript:window.pwned=1">a script link</a> and <a href="#fn1">a note</a>.</p>
      <p id="fn1">The note.</p>
      <p id="tabgentWebAnchor">Clobbering paragraph.</p>
      <script>window.pwned = 1</script>
      <img src="${origin}/img/tracker.png" onerror="window.pwned = 1" alt="Tracker">
      <iframe src="${origin}/frame"></iframe>
      <form action="${origin}/collect"><input name="q"><button>Send</button></form>
      <style>#content { display: none }</style>
      <svg><script>window.pwned = 1</script></svg>
      <div style="position: fixed; inset: 0">Overlay text</div>
      <p>Paragraph ${'words '.repeat(60)}</p>
    </article>`;
    const tampered = Buffer.from(savedHtml.toString().replace(/<article>[\s\S]*<\/article>/, evil));
    fs.writeFileSync(htmlPath, tampered);
    const forged = JSON.parse(savedRecord);
    forged.files.html = {
      file: 'article.html',
      sha256: crypto.createHash('sha256').update(tampered).digest('hex'),
      bytes: tampered.length,
    };
    fs.writeFileSync(recordPath, JSON.stringify(forged));
    const beforeEvil = requested.length;
    await reader.reload();
    await reader.waitForSelector('#content #user-content-evil');
    await wait(800);
    assert.equal(await reader.evaluate(() => window.pwned), undefined);
    assert.equal(
      await reader.$$eval(
        '#content script, #content iframe, #content form, #content input, #content style, #content svg, #content [style], #content [onerror]',
        (l) => l.length,
      ),
      0,
    );
    assert.equal(await reader.$$eval('#content a[href^="javascript"]', (l) => l.length), 0);
    assert.equal(await reader.getAttribute('#content a[href^="#"]', 'href'), '#user-content-fn1');
    assert.equal(
      await reader.evaluate(() => typeof globalThis.tabgentWebAnchor?.resolve),
      'function',
    );
    assert(await reader.isVisible('#content'));
    assert.deepEqual(requested.slice(beforeEvil), [], 'The reader loads nothing from the web');
    fs.writeFileSync(htmlPath, savedHtml);
    fs.writeFileSync(recordPath, savedRecord);
    await reader.close();
    console.log('PASS the reader refuses a changed copy and cleans untrusted markup');

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

    // Text the extractor dropped is put back in place; the page and article.json say so.
    await page.goto(origin + '/compare');
    await wait(800);
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    const compareFolder = await until(() =>
      folders().find(
        (name) =>
          name.startsWith('article-compared-') &&
          fs.existsSync(path.join(articles, name, 'article.json')),
      ),
    );
    assert(compareFolder, 'The compared page is clipped');
    assert.match(
      read(compareFolder, 'article.md'),
      /Compare paragraph 5[^\n]*\n\n### First approach\n\nReads every page twice[\s\S]*### Second approach[\s\S]*\n\nAfter paragraph 1/,
    );
    const compared = record(compareFolder).coverage;
    assert.equal(compared.restoredPassages, 1);
    assert(compared.ratio < 0.9 && compared.restoredChars > 200, JSON.stringify(compared));
    const restoredText = await message('clipRestored', '1');
    assert(
      await until(async () => (await promptText(page)).includes(restoredText)),
      'The page says text was put back',
    );
    console.log('PASS text the extractor dropped is put back and recorded in article.json');

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
    assert.equal(record(shortFolder).contentStatus, 'text');
    console.log('PASS a page with little text can be saved whole');

    // Only an embedded player: saved whole, the clip holds only its link, and the page says
    // so instead of reporting a normal clip.
    await page.goto(origin + '/video');
    await wait(800);
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    assert(await until(async () => (await promptText(page)).startsWith(little)));
    await clickIn(page, 'tabgent-clip', button(await message('clipWholePage')));
    const videoFolder = await until(() =>
      folders().find(
        (name) =>
          name.startsWith('article-recorded-talk-') &&
          fs.existsSync(path.join(articles, name, 'article.json')),
      ),
    );
    assert(videoFolder, 'The page with only a player is saved');
    assert.equal(record(videoFolder).contentStatus, 'linksOnly');
    assert.match(read(videoFolder, 'article.md'), new RegExp(`\\(${origin}/embed/talk\\)`));
    const linksOnlyText = await message('clipLinksOnly', 'Recorded talk');
    assert(
      await until(async () => (await promptText(page)).startsWith(linksOnlyText)),
      'The page says only links were saved',
    );
    assert(!(await promptText(page)).includes(await message('clipSaved', 'Recorded talk', '1')));
    console.log('PASS a page with only an embedded player is saved as links only, and says so');

    // A YouTube video: the player's data is read in the page's own world, its own English
    // captions (not the automatic track) are saved as a transcript with chapters and links
    // to each moment, and its thumbnail is the cover.
    await page.goto('https://www.youtube.com/watch?v=FIXTUREvid1');
    await wait(800);
    youtubeRequests.length = 0;
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    const videoFolderOf = (id) =>
      folders().find(
        (name) =>
          name.startsWith(`article-fixture-video-${id.slice(-1)}-`) &&
          fs.existsSync(path.join(articles, name, 'article.json')),
      );
    const talk = await until(() => videoFolderOf('FIXTUREvid1'), 20000);
    assert(talk, 'The video is clipped');
    const talkRecord = record(talk);
    assert.equal(talkRecord.origin.extractor, 'youtube');
    assert.equal(talkRecord.contentStatus, 'text');
    assert.deepEqual(talkRecord.transcript, {
      status: 'saved',
      reason: '',
      kind: 'manual',
      source: 'captions',
      language: 'en',
      name: 'English',
    });
    assert.equal(talkRecord.author, 'Fixture Channel');
    assert.equal(talkRecord.publishedAt, '2026-08-14T05:00:01-07:00');
    const talkCover = `${crypto.createHash('sha256').update(THUMBNAIL).digest('hex').slice(0, 16)}.png`;
    assert.deepEqual(talkRecord.cover, {
      source: 'https://i.ytimg.com/vi/FIXTUREvid1/maxresdefault.jpg',
      file: `assets/${talkCover}`,
    });
    const talkMarkdown = read(talk, 'article.md');
    const moment = (at) => `https://www.youtube.com/watch?v=FIXTUREvid1&t=${at}s`;
    assert(talkMarkdown.includes(`## ${await message('clipTranscriptOf', 'English')}`));
    assert(
      talkMarkdown.includes(
        `### [0:30](${moment(30)}) Middle\n\n[0:30](${moment(30)}) Caption sentence 11`,
      ),
    );
    assert(talkMarkdown.includes(`[0:00](${moment(0)}) Caption sentence 1 of the talk.`));
    assert.match(talkMarkdown, /Caption sentence 30 of the talk\.\n$/);
    // Only the chosen track's text was requested, from the page.
    assert.deepEqual(
      youtubeRequests
        .filter((url) => url.includes('/api/timedtext'))
        .map((url) => new URL(url).searchParams.get('kind') || 'own'),
      ['own'],
    );
    const transcriptText = await message('clipTranscriptSaved', 'English');
    assert(
      await until(async () => (await promptText(page)).includes(transcriptText)),
      'The page says the transcript was saved',
    );
    // YouTube does not return the automatic track's text: only the description is saved,
    // and the page says why.
    await page.goto('https://www.youtube.com/watch?v=FIXTUREvid4');
    await wait(800);
    await panel(`(() => {
      document.getElementById('readingButton').click();
      document.getElementById('readingClip').click();
    })()`);
    const episodeFolder = await until(() => videoFolderOf('FIXTUREvid4'), 20000);
    assert(episodeFolder, 'The video without caption text is clipped');
    assert.equal(record(episodeFolder).contentStatus, 'notesOnly');
    assert.equal(record(episodeFolder).transcript.reason, 'empty');
    assert.match(read(episodeFolder, 'article.md'), /Show notes of the fixture episode/);
    const notesText = [
      await message('clipNotesOnly', 'Fixture video 4'),
      await message('clipTranscriptEmpty'),
    ].join(' ');
    assert(
      await until(async () => (await promptText(page)).startsWith(notesText)),
      await promptText(page),
    );
    assert.deepEqual(outside, [], 'Nothing outside the fixtures is requested');
    console.log('PASS a YouTube video saves its captions as a transcript, or says why it cannot');

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

    // Offline after a restart: the library opens the clipped copy from the vault.
    panel.close();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await context.close();
    await launch();
    const library = await context.newPage();
    await library.goto(`chrome-extension://${id}/epub/reader.html`);
    await library.waitForSelector('#books .item');
    const entry = await until(() =>
      library.evaluate(
        (url) => {
          const item = [...document.querySelectorAll('#books li')].find((li) =>
            li.querySelector('.item')?.getAttribute('href')?.endsWith(url),
          );
          return (
            item && {
              href: item.querySelector('.item').getAttribute('href'),
              original: item.querySelector('.original')?.getAttribute('href'),
              meta: item.querySelector('.meta').textContent,
            }
          );
        },
        '?url=' + origin + '/essays/autonomy?id=3',
      ),
    );
    assert(entry, 'The library lists the clipped page');
    assert.equal(entry.original, origin + '/essays/autonomy?id=3');
    assert(entry.meta.includes(await message('libraryKindClipped')), entry.meta);
    // The clipped page shows its cover from the vault; the player page says it holds links.
    assert(
      await until(() =>
        library.evaluate(
          (url) =>
            [...document.querySelectorAll('#books li')]
              .find((li) => li.querySelector('.item')?.getAttribute('href')?.endsWith(url))
              ?.querySelector('img.cover')?.naturalWidth === 40,
          '?url=' + origin + '/essays/autonomy?id=3',
        ),
      ),
      'The library shows the cover',
    );
    const linksOnlyLabel = await message('libraryLinksOnly');
    const videoMeta = await library.evaluate(
      (url) =>
        [...document.querySelectorAll('#books li')]
          .find((li) => li.querySelector('.item')?.getAttribute('href')?.endsWith(url))
          ?.querySelector('.meta').textContent,
      '?url=' + origin + '/video',
    );
    assert(videoMeta?.includes(linksOnlyLabel), videoMeta);
    const episodeMeta = await library.evaluate(
      (url) =>
        [...document.querySelectorAll('#books li')]
          .find((li) => li.querySelector('.item')?.getAttribute('href')?.endsWith(url))
          ?.querySelector('.meta').textContent,
      '?url=https://www.youtube.com/watch?v=FIXTUREvid4',
    );
    assert(episodeMeta?.includes(await message('libraryNotesOnly')), episodeMeta);
    assert(!entry.meta.includes(linksOnlyLabel), entry.meta);
    // Its clipped copy says it holds only links.
    const videoReader = await context.newPage();
    await videoReader.goto(readerPrefix + origin + '/video');
    await videoReader.waitForSelector('#content a');
    assert.equal(await videoReader.textContent('#notice'), await message('clipLinksOnlyNotice'));
    assert.equal(await videoReader.isVisible('#notice'), true);
    await videoReader.close();
    // A video without its transcript says so, and why.
    const episodeReader = await context.newPage();
    await episodeReader.goto(readerPrefix + 'https://www.youtube.com/watch?v=FIXTUREvid4');
    await episodeReader.waitForSelector('#content p');
    assert.equal(
      await episodeReader.textContent('#notice'),
      [await message('clipNotesOnlyNotice'), await message('clipTranscriptEmpty')].join(' '),
    );
    await episodeReader.close();
    await library.click(`#books a.item[href="${entry.href}"]`);
    await library.waitForURL(readerPrefix + '**');
    await library.waitForSelector('#content p');
    assert(await until(async () => (await painted(library)) === 3), 'Highlights after restart');
    assert(
      await until(() =>
        library.evaluate(() => document.querySelector('#content img')?.naturalWidth === 32),
      ),
      'The image is shown offline',
    );
    console.log('PASS after a restart and offline, the library opens the clipped copy');

    // Deleting the clipped copy keeps the page's highlights and discussion.
    library.once('dialog', (dialog) => dialog.accept());
    await library.click('#delete');
    const deletedText = await message('clipDeleted');
    assert(await until(async () => (await library.textContent('#status')).startsWith(deletedText)));
    assert(!fs.existsSync(path.join(articles, folder, 'article.json')));
    assert.equal(JSON.parse(read(folder, 'anchors.json')).highlights.length, 3);
    console.log('PASS deleting the clipped copy keeps the highlights');

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
