// Subscriptions in real Chromium with the source extension and the real connector. A
// temporary profile, HOME and CODEX_HOME isolate the browser, the vault and Codex state;
// every feed is generated and served from 127.0.0.1, so no request leaves the machine.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { vaultDocuments } = require('./vault-files.cjs'),
  zlib = require('node:zlib'),
  { execSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const extension = path.join(root, 'extension');
const shots = process.env.FEEDS_SHOTS;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}

const day = (n) => new Date(Date.UTC(2025, 5, 1) + n * 3600_000).toUTCString();
function rss(title, numbers, { content = '', link = (n) => `/posts/${n}` } = {}) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" ` +
    `xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${title}</title>` +
    `<link>http://site.invalid/</link>` +
    numbers
      .map(
        (n) =>
          `<item><title>${title} post ${n}</title><guid>${title}-${n}</guid>` +
          `<link>{origin}${link(n)}?utm_source=rss</link><pubDate>${day(n)}</pubDate>` +
          `<description>Summary ${n}</description>` +
          (content ? `<content:encoded><![CDATA[${content}]]></content:encoded>` : '') +
          '</item>',
      )
      .join('') +
    '</channel></rss>'
  );
}
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Notes</title><link href="{origin}/site/"/>
<entry><id>tag:atom,1</id><title>Atom entry</title><link href="{origin}/posts/atom-1"/>
<updated>2025-06-02T10:00:00Z</updated><summary>Only a summary.</summary></entry></feed>`;
const jsonFeed = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON Notes',
  items: [{ id: 'j1', url: '{origin}/posts/j1', title: 'JSON entry', content_text: 'Hello' }],
});
const site = `<!doctype html><html><head><title>A site</title>
<link rel="alternate" type="application/atom+xml" title="Atom Notes" href="../atom.xml">
</head><body>Home</body></html>`;
const bomb = `<?xml version="1.0"?><!DOCTYPE rss [
<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
<!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]><rss><channel><title>&d;</title></channel></rss>`;
// A real 32x18 PNG, so the reader can show it.
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
// Reading items: one with its whole text in the feed (and an image), one with a summary
// whose page has the full text.
const fullText = [...Array(20).keys()]
  .map((n) => `<p>Full item paragraph ${n}: careful readers return to difficult passages.</p>`)
  .join('');
const readingFeed = `<?xml version="1.0"?><rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Reading</title>
<link>{origin}/</link>
<item><title>Full item</title><guid>read-full</guid><link>{origin}/article/full</link>
<pubDate>${day(40)}</pubDate><description>The whole item.</description>
<content:encoded><![CDATA[${fullText}<p><img src="{origin}/img/pic.png" alt="Picture"></p>]]></content:encoded></item>
<item><title>Summary item</title><guid>read-summary</guid>
<link>{origin}/article/summary?utm_source=rss</link><pubDate>${day(41)}</pubDate>
<description>Only a teaser.</description></item>
</channel></rss>`;
const articlePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Summary item</title></head>
<body><nav><a href="/">Home</a></nav><main><article><h1>Summary item</h1>${[...Array(10).keys()]
  .map((n) => `<p>Article paragraph ${n}: the page holds the whole text of the item.</p>`)
  .join('')}</article></main><footer>Footer</footer></body></html>`;
// About 4.5 MB: 200 entries with long content, parsed while the vault stays responsive.
const big = rss('Big', [...Array(200).keys()], { content: '<p>' + 'x'.repeat(22000) + '</p>' });

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-feeds-'));
  const profile = path.join(temp, 'profile'),
    home = path.join(temp, 'home'),
    codexHome = path.join(home, 'codex'),
    vault = path.join(home, 'Tabgent'),
    index = path.join(vault, '.tabgent/feeds.db');
  const personal = ['ReadingVault', 'Tabgent'].map((name) => path.join(os.homedir(), name));
  const personalState = () =>
    personal.map((dir) => (fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : null)).join();
  const personalBefore = personalState();
  fs.mkdirSync(codexHome, { recursive: true });
  const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
  const hits = [];
  let flaky = 0,
    changing = 'valid';
  const server = http.createServer((request, response) => {
    hits.push({ url: request.url, headers: request.headers });
    const origin = `http://${request.headers.host}`;
    const send = (body, type, status = 200, headers = {}) => {
      response.writeHead(status, { 'content-type': type, ...headers });
      response.end(typeof body === 'string' ? body.replaceAll('{origin}', origin) : body);
    };
    const xml = 'application/rss+xml; charset=utf-8';
    if (request.url === '/full.xml') {
      const etag = '"full-v1"';
      if (request.headers['if-none-match'] === etag) return send('', xml, 304, { etag });
      return send(rss('Full', [1, 2, 3], { content: '<p>Whole text.</p>' }), xml, 200, { etag });
    }
    if (request.url === '/atom.xml') return send(atom, 'application/atom+xml');
    if (request.url === '/feed.json') return send(jsonFeed, 'application/feed+json');
    if (request.url === '/flaky.xml')
      return ++flaky === 1 ? send('busy', 'text/plain', 500) : send(rss('Flaky', [1]), xml);
    if (request.url === '/gzip.xml') {
      const body = zlib.gzipSync(rss('Gzip', [1, 2]).replaceAll('{origin}', origin));
      return send(body, xml, 200, { 'content-encoding': 'gzip' });
    }
    if (request.url === '/changing.xml')
      return send(changing === 'valid' ? rss('Changing', [1]) : bomb, xml);
    if (request.url === '/bomb.xml') return send(bomb, xml);
    if (request.url === '/big.xml') return send(big, xml);
    if (request.url === '/site/') return send(site, 'text/html; charset=utf-8');
    if (request.url === '/reading.xml') return send(readingFeed, xml);
    if (request.url.startsWith('/article/summary'))
      return send(articlePage, 'text/html; charset=utf-8');
    if (request.url === '/img/pic.png') return send(PICTURE, 'image/png');
    send('<!doctype html><title>Not a feed</title>', 'text/html', 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context,
    passed = false;
  try {
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
    const start =
      'import sys; native, codex = sys.argv[1:3]; del sys.argv[1:3]; sys.path.insert(0, native); ' +
      'import host; host.executable = lambda: codex; host.main()';
    const connector = path.join(temp, 'connector');
    fs.writeFileSync(
      connector,
      `#!/bin/sh\nexport HOME='${home}' CODEX_HOME='${codexHome}'\nexec '${python}' -c '${start}' '${path.join(extension, 'native')}' '${codex}' "$@" 2>>'${temp}/host.err'\n`,
      { mode: 0o700 },
    );
    fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'NativeMessagingHosts/com.tabgent.codex.json'),
      JSON.stringify({
        name: 'com.tabgent.codex',
        description: 'Tabgent connector for subscription tests',
        path: connector,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    const libraryUrl = `chrome-extension://${id}/epub/reader.html?view=feeds`;
    let worker, page;
    const logs = [];
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        viewport: { width: 1200, height: 900 },
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      context.on('page', (opened) => {
        opened.on('console', (message) => logs.push(message.text()));
        opened.on('pageerror', (error) => logs.push('pageerror: ' + error.message));
      });
      worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
      // A cookie for the feed server: feed requests must not send it.
      await context.addCookies([{ name: 'session', value: 'secret', url: origin }]);
    }
    const message = (key, ...args) =>
      worker.evaluate(([key, args]) => chrome.i18n.getMessage(key, args), [key, args]);
    async function openLibrary() {
      page = await context.newPage();
      await page.goto(libraryUrl);
      await page.waitForSelector('#feedsPanel:not([hidden])');
      return page;
    }
    const sources = () =>
      page.$$eval('#feedSources .source:not(.all)', (entries) =>
        entries.map((entry) => ({
          title: entry.querySelector('.name span').textContent,
          unread: Number(entry.querySelector('.count')?.textContent || 0),
          status: entry.querySelector('.meta').textContent,
        })),
      );
    const items = () =>
      page.$$eval('#feedItems .feed-item', (entries) =>
        entries.map((entry) => ({
          title: entry.querySelector('.title').textContent,
          href: entry.querySelector('a.title')?.getAttribute('href') || '',
        })),
      );
    const query = (sql) => {
      const result = spawnSync(python, [
        '-c',
        'import json, sqlite3, sys; db = sqlite3.connect(sys.argv[1]); ' +
          'rows = db.execute(sys.argv[2]).fetchall(); db.commit(); print(json.dumps(rows))',
        index,
        sql,
      ]);
      assert.equal(result.status, 0, String(result.stderr));
      return JSON.parse(String(result.stdout));
    };
    const send = (value) => page.evaluate((value) => chrome.runtime.sendMessage(value), value);
    async function drag(selector, needle) {
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
    // CDP sees inside the reading toolbar's closed shadow root.
    async function clickAction(action) {
      const client = await page.context().newCDPSession(page);
      const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      let target = null;
      (function walk(node) {
        const attributes = node.attributes || [];
        const at = attributes.indexOf('data-action');
        if (at >= 0 && attributes[at + 1] === action) target = node;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
      })(root);
      assert(target, `No ${action} button`);
      const { model } = await client.send('DOM.getBoxModel', {
        backendNodeId: target.backendNodeId,
      });
      await client.detach();
      await page.mouse.click(
        (model.border[0] + model.border[4]) / 2,
        (model.border[1] + model.border[5]) / 2,
      );
    }
    const openItem = async (title) => {
      await page.locator('#feedItems a.title', { hasText: title }).click();
      await page.waitForURL('**/clip/reader.html?url=**');
      await page.waitForSelector('#content p');
    };
    const backToFeeds = async () => {
      await page.click('#back');
      await page.waitForSelector('#feedsPanel:not([hidden])');
    };
    const statusIs = async (key, ...args) => {
      const expected = await message(key, ...args);
      return until(async () => (await page.textContent('#feedStatus')) === expected);
    };

    await launch();
    await openLibrary();
    const none = await message('feedsNone');
    assert(await until(async () => (await page.textContent('#feedItemsStatus')) === none));
    assert.equal(fs.existsSync(index), false, 'Opening Subscriptions creates nothing');

    // 1. By feed address: a preview, then the subscription and its items.
    await page.fill('#feedUrl', origin + '/full.xml');
    await page.click('#feedAdd');
    await page.waitForSelector('#feedFound:not([hidden]) button.primary');
    assert.equal(await page.textContent('#feedFound .title'), 'Full');
    await page.click('#feedFound button.primary');
    assert(await statusIs('feedsSubscribedNew', 'Full', 3));
    assert(await until(async () => (await items()).length === 3));
    // An item opens in Tabgent's reader, by its address without tracking parameters.
    assert.deepEqual((await items())[0], {
      title: 'Full post 3',
      href: `chrome-extension://${id}/clip/reader.html?url=${origin}/posts/3`,
    });
    const [listedFull] = await sources();
    assert.equal(listedFull.title, 'Full');
    assert.equal(listedFull.unread, 3);
    const updated = (await message('feedsUpdated', '')).trim();
    assert(listedFull.status.startsWith(updated.split(' ')[0]), listedFull.status);
    const alarm = await worker.evaluate(() => chrome.alarms.get('feeds'));
    assert.equal(alarm?.periodInMinutes, 15);
    console.log('PASS subscribing by feed address previews the feed and lists its items');

    // By website address: the page's <link rel="alternate"> is found.
    await page.fill('#feedUrl', origin + '/site/');
    await page.click('#feedAdd');
    await page.waitForSelector('#feedFound:not([hidden]) button.primary');
    assert.equal(await page.textContent('#feedFound .title'), 'Atom Notes');
    await page.click('#feedFound button.primary');
    assert(await statusIs('feedsSubscribedNew', 'Atom Notes', 1));
    // A page without feeds.
    await page.fill('#feedUrl', origin + '/nothing/');
    await page.click('#feedAdd');
    assert(await statusIs('feedsAddFailed', 'HTTP 404'));
    console.log('PASS subscribing by website address finds the declared feed');

    // By OPML: known feeds are marked; new ones are checked at once.
    const opml = `<?xml version="1.0"?><opml version="2.0"><body>
<outline text="Reading"><outline text="JSON" xmlUrl="${origin}/feed.json"/>
<outline text="Full again" xmlUrl="${origin}/full.xml"/></outline>
<outline text="Flaky" xmlUrl="${origin}/flaky.xml"/>
<outline text="Gzip" xmlUrl="${origin}/gzip.xml"/>
<outline text="Changing" xmlUrl="${origin}/changing.xml"/></body></opml>`;
    await page.setInputFiles('#feedOpml', {
      name: 'subscriptions.opml',
      mimeType: 'text/x-opml',
      buffer: Buffer.from(opml),
    });
    await page.waitForSelector('#feedFound:not([hidden]) ul.outlines');
    assert.equal(await page.locator('#feedFound input:disabled').count(), 1);
    await page.click('#feedFound button.primary');
    assert(await statusIs('feedsImported', 4));
    assert(
      await until(
        () =>
          query(
            "SELECT COUNT(*) FROM items WHERE source_id IN (SELECT id FROM sources WHERE title IN ('JSON', 'Gzip', 'Changing'))",
          )[0][0] === 4,
      ),
      'The imported feeds are checked',
    );
    assert.deepEqual(query('SELECT url, category FROM sources ORDER BY url'), [
      [origin + '/atom.xml', ''],
      [origin + '/changing.xml', ''],
      [origin + '/feed.json', 'Reading'],
      [origin + '/flaky.xml', ''],
      [origin + '/full.xml', ''],
      [origin + '/gzip.xml', ''],
    ]);
    const flakyState = () =>
      query("SELECT failures, last_error FROM sources WHERE url LIKE '%flaky.xml'")[0];
    assert.deepEqual(flakyState(), [1, 'HTTP 500']);
    assert.equal(fs.existsSync(path.join(vault, 'Articles')), false, 'Subscribing adds no notes');
    console.log('PASS OPML import adds feeds with categories; nothing is added to Articles');
    if (shots) await page.screenshot({ path: path.join(shots, 'subscriptions.png') });

    // No cookies or referrer on feed requests.
    const feedHits = hits.filter((hit) => /\.(xml|json)$/.test(hit.url));
    assert(feedHits.length >= 6);
    for (const hit of feedHits) {
      assert.equal(hit.headers.cookie, undefined, hit.url);
      assert.equal(hit.headers.referer, undefined, hit.url);
    }

    // 2. Refresh: a conditional request answered 304 adds nothing; the failing feed recovers.
    hits.length = 0;
    await page.click('#feedRefreshAll');
    assert(await statusIs('feedsRefreshed', 6, 1), await page.textContent('#feedStatus'));
    const full = hits.find((hit) => hit.url === '/full.xml');
    assert.equal(full.headers['if-none-match'], '"full-v1"');
    assert.equal(query("SELECT COUNT(*) FROM items WHERE key LIKE 'Full-%'")[0][0], 3);
    assert.deepEqual(flakyState(), [0, null]);
    console.log('PASS refreshing sends validators; a 304 adds nothing; a failing feed recovers');

    // 7. A hostile feed is refused without expanding it, and the vault keeps answering.
    changing = 'bomb';
    const changingId = query("SELECT id FROM sources WHERE url LIKE '%changing.xml'")[0][0];
    await send({ type: 'feedsRefresh', sourceId: changingId });
    const [failures, reason] = query(
      `SELECT failures, last_error FROM sources WHERE id = '${changingId}'`,
    )[0];
    assert.equal(failures, 1);
    assert.match(reason, /internal subset/);
    await page.fill('#feedUrl', origin + '/bomb.xml');
    await page.click('#feedAdd');
    assert(await until(async () => /internal subset/.test(await page.textContent('#feedStatus'))));
    console.log('PASS a hostile feed is refused, and its subscription shows why');

    // A large feed is parsed outside the vault queue: other vault requests still answer.
    // The library keeps asking the vault while the feed is fetched, parsed and stored.
    const probing = page.evaluate(async () => {
      const latencies = [];
      for (const end = Date.now() + 20000; Date.now() < end && !globalThis.stopProbe;) {
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ type: 'libraryDocuments' });
        if (!Array.isArray(reply.documents)) throw Error(JSON.stringify(reply));
        latencies.push(performance.now() - started);
      }
      return latencies;
    });
    await wait(300);
    hits.length = 0;
    const importStarted = Date.now();
    const imported = await send({ type: 'feedsImport', outlines: [{ url: origin + '/big.xml' }] });
    assert.equal(imported.created, 1);
    assert(
      await until(
        () => query("SELECT COUNT(*) FROM items WHERE key LIKE 'Big-%'")[0][0] === 20,
        30000,
      ),
      'The large feed is stored: its newest 20 entries',
    );
    const ingestTook = Date.now() - importStarted;
    await page.evaluate(() => (globalThis.stopProbe = true));
    const latencies = await probing;
    assert(hits.some((hit) => hit.url === '/big.xml'));
    const elapsed = Math.round(Math.max(...latencies));
    assert(latencies.length >= 3, `Only ${latencies.length} vault requests ran`);
    assert(elapsed < 2000, `The vault answered in ${elapsed} ms during a large feed`);
    console.log(
      `PASS the vault answers within ${elapsed} ms (${latencies.length} requests) while a 4.5 MB feed is stored (${ingestTook} ms)`,
    );

    // Reading items in Tabgent: an item with its whole text, then one with a summary.
    await openLibrary();
    hits.length = 0;
    await send({ type: 'feedsSubscribe', url: origin + '/reading.xml' });
    await page.reload();
    await page.waitForSelector('#feedsPanel:not([hidden])');
    assert(await until(async () => (await items()).some((item) => item.title === 'Full item')));
    await openItem('Full item');
    assert.equal(await page.textContent('#pageTitle'), 'Full item');
    assert.match(await page.textContent('#content'), /Full item paragraph 19/);
    assert.match(await page.textContent('#byline'), /Reading/);
    // Its image comes through the worker, without cookies.
    await page.evaluate(() => document.querySelector('#content img')?.scrollIntoView());
    assert(
      await until(() =>
        page.evaluate(() => {
          const image = document.querySelector('#content img');
          return image?.src.startsWith('blob:') && image.naturalWidth === 32;
        }),
      ),
      'The item image is shown',
    );
    // Without cookies, with the Referer the item's page sends (same origin: its address).
    const imageHit = hits.find((hit) => hit.url === '/img/pic.png');
    assert.equal(imageHit.headers.cookie, undefined);
    assert.equal(imageHit.headers.referer, origin + '/article/full');
    assert.equal(
      hits.some((hit) => hit.url === '/article/full'),
      false,
      'An item with its whole text does not fetch its page',
    );
    assert.notEqual(query("SELECT read_at FROM items WHERE key = 'read-full'")[0][0], null);
    assert.equal(fs.existsSync(path.join(vault, 'Articles')), false, 'Reading saves nothing');
    console.log(
      'PASS a feed item opens in the reader, with its images, marked read, saving nothing',
    );

    // A summary: the full text comes from its page, fetched with the site's cookies.
    await backToFeeds();
    await openItem('Summary item');
    assert(
      await until(async () => /Article paragraph 3/.test(await page.textContent('#content'))),
      'The full text is shown',
    );
    assert.doesNotMatch(await page.textContent('#content'), /Footer|Home/);
    // Fetched at its address without tracking parameters, with the cookies of the item's own
    // site (the subscription's).
    assert(!hits.some((hit) => hit.url === '/article/summary?utm_source=rss'));
    const pageHit = hits.find((hit) => hit.url === '/article/summary');
    assert.match(pageHit.headers.cookie || '', /session=secret/);
    assert.equal(pageHit.headers.referer, undefined);
    assert.deepEqual(
      query(
        "SELECT item_content.kind FROM item_content JOIN items ON items.id = item_content.item_id WHERE items.key = 'read-summary'",
      ),
      [['fulltext']],
    );
    assert.equal(await page.getAttribute('#original', 'href'), origin + '/article/summary');
    console.log('PASS a summary item shows the full text of its page, kept for next time');

    // The first highlight saves the item as a vault document with a feed origin.
    await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#content p')].find((p) =>
        p.textContent.includes('Article paragraph 3'),
      );
      paragraph.id = 'probe';
    });
    await drag('#probe', 'Article paragraph 3');
    await clickAction('highlight');
    const articles = path.join(vault, '.tabgent/documents');
    const folder = await until(
      () =>
        fs.existsSync(articles) &&
        fs
          .readdirSync(articles)
          .find((name) => fs.existsSync(path.join(articles, name, 'anchors.json'))),
    );
    assert(folder, 'The item has a document folder');
    const anchors = () =>
      JSON.parse(fs.readFileSync(path.join(articles, folder, 'anchors.json'), 'utf8'));
    assert(await until(() => anchors().highlights.length === 1), 'The highlight is saved');
    assert.equal(anchors().highlights[0].text, 'Article paragraph 3');
    assert.equal(anchors().highlights[0].anchor.view, 'clip');
    assert.equal(anchors().document.url, origin + '/article/summary');
    const record = JSON.parse(fs.readFileSync(path.join(articles, folder, 'article.json'), 'utf8'));
    assert.equal(record.origin.type, 'feed');
    assert.equal(record.origin.method, 'fulltext');
    assert.equal(record.origin.sourceTitle, 'Reading');
    const saved = vaultDocuments(vault).find((doc) => doc.id === folder);
    assert.match(saved.fullText, /Article paragraph 3/);
    // An item saved from a feed is filed by its content, with the feed named.
    assert.equal(saved.category, 'articles');
    assert.match(saved.notes, /\nfeed: "Reading"\n/);
    assert.match(saved.notes, /- 来源：RSS《Reading》/);
    assert.notEqual(query("SELECT document_id FROM items WHERE key = 'read-summary'")[0][0], null);
    assert(await until(() => page.isDisabled('#save')), 'The reader shows it as saved');
    console.log('PASS the first highlight saves the item as a document with its text');

    // The inbox: views, states and keys.
    await backToFeeds();
    await page.click('#feedViews [data-view="all"]');
    const row = (title) => page.locator('#feedItems .feed-item', { hasText: title });
    assert(await until(async () => (await row('Summary item').count()) === 1));
    assert.match(
      await row('Summary item').locator('.meta').textContent(),
      new RegExp(await message('feedsSaved')),
    );
    await row('Full item').focus();
    await page.keyboard.press('l');
    await page.click('#feedViews [data-view="later"]');
    assert(await until(async () => (await row('Full item').count()) === 1), 'Later lists it');
    await row('Full item').focus();
    await page.keyboard.press('e');
    await page.click('#feedViews [data-view="archive"]');
    assert(await until(async () => (await row('Full item').count()) === 1), 'Archive lists it');
    assert.equal(query("SELECT state FROM items WHERE key = 'read-full'")[0][0], 'archive');
    // m marks it unread again; j and k move between rows.
    await page.click('#feedViews [data-view="all"]');
    assert(await until(async () => (await row('Full item').count()) === 1));
    await row('Full item').focus();
    await page.keyboard.press('m');
    assert(
      await until(() => query("SELECT read_at FROM items WHERE key = 'read-full'")[0][0] === null),
    );
    await page.locator('#feedItems .feed-item').first().focus();
    await page.keyboard.press('j');
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll('#feedItems .feed-item')].indexOf(document.activeElement),
      ),
      1,
    );
    // A saved item's later state is its document's.
    await row('Summary item').focus();
    await page.keyboard.press('l');
    assert(await until(() => anchors().document.library?.state === 'later'));
    await page.click('#feedViews [data-view="later"]');
    assert(await until(async () => (await row('Summary item').count()) === 1), 'Saved, later');
    console.log('PASS the inbox: later, archive, read and unread, keys, saved items');

    // 6. After a browser restart, overdue subscriptions are checked once, a minute later.
    // (Playwright's relaunch reports the command-line extension as installed, not started;
    // both paths schedule the same check.)
    await context.close();
    query("UPDATE sources SET next_fetch_at = 0 WHERE url LIKE '%gzip.xml'");
    await launch();
    const next = await until(() => worker.evaluate(() => chrome.alarms.get('feeds-next')));
    assert(
      next && next.scheduledTime > Date.now() + 30000,
      JSON.stringify(
        await worker.evaluate(async () => ({
          alarms: await chrome.alarms.getAll(),
          stored: await chrome.storage.local.get(null),
        })),
      ),
    );
    hits.length = 0;
    // Unpacked extensions may fire alarms early; this stands in for the minute's wait.
    await worker.evaluate(() => chrome.alarms.create('feeds-next', { when: Date.now() + 100 }));
    assert(
      await until(() => hits.some((hit) => hit.url === '/gzip.xml')),
      'The overdue feed is checked',
    );
    assert(!hits.some((hit) => hit.url === '/full.xml'), 'Feeds not yet due are not checked');
    console.log('PASS after a restart, overdue subscriptions are checked');

    // Unsubscribing removes the items; the tab lists what is left.
    await openLibrary();
    page.on('dialog', (dialog) => dialog.accept());
    const before = (await sources()).length;
    await page.locator('#feedSources .source:not(.all)').first().locator('summary').click();
    await page.locator('#feedSources .source:not(.all)').first().locator('button.danger').click();
    assert(await until(async () => (await sources()).length === before - 1));
    await page.click('#documentsTab');
    await page.waitForSelector('#documentsPanel:not([hidden])');
    assert.equal(new URL(page.url()).search, '');
    console.log('PASS unsubscribing and switching back to the documents tab');

    assert(!logs.some((line) => line.startsWith('pageerror')), logs.join('\n'));
    assert.equal(personalState(), personalBefore, 'The personal vault was not touched');
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
