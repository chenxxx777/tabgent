// Clipping extraction on generated pages: Defuddle, the shared sanitizer settings and
// Turndown run in the page as the service worker injects them. Covers lazy images, tables,
// code, links, embeds, unsafe markup, a synthetic X thread, X timelines, selections, the
// whole-page fallback and short pages. Nothing is fetched by the clipping script.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { chromium } = require('playwright');
const extension = path.resolve(__dirname, '..');
const files = [
  'vendor/defuddle/defuddle.js',
  'vendor/turndown/turndown.js',
  'vendor/dompurify/purify.umd.js',
  'clip/sanitize-config.js',
  'clip/clip-content.js',
].map((file) => path.join(extension, file));

const paragraphs = (n, prefix) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>${prefix} paragraph ${i + 1} explains why careful readers return to difficult passages and write down what they notice about the argument.</p>`,
  ).join('\n');
// One long image address used many times: its placeholders could ask for more room than
// the Markdown limit.
const longImage = `https://cdn.clip.test/${'signed-'.repeat(560)}.png`;
const pages = {
  '/many-images': `<!doctype html><html><head><title>Many images</title></head><body><main>
<h1>Many images</h1><p>${'A paragraph about the images. '.repeat(40)}</p>
${Array.from({ length: 900 }, (_, i) => `<p>Figure ${i}</p><img src="${longImage}" width="400" height="300" alt="Figure ${i}">`).join('\n')}
</main></body></html>`,
  '/blog/autonomy': `<!doctype html><html lang="en"><head><title>On Autonomy | Fixture Blog</title>
    <meta name="author" content="Fixture Author"><meta property="og:site_name" content="Fixture Blog">
    <meta property="article:published_time" content="2026-10-01T08:00:00Z"></head><body>
    <header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/archive">Archive</a></nav></header>
    <aside class="sidebar"><h3>Subscribe</h3><p>Join the newsletter for more posts.</p>
      <form action="https://collector.example.test/"><input name="email"><button>Sign up</button></form></aside>
    <main><article>
      <h1>On Autonomy</h1>
      <p>Autonomy is the endorsement of one's own actions. <a href="/notes/endorsement">Read the notes</a>,
        see the <a href="#fn1">footnote</a> and <a href="javascript:alert(1)">this link</a>.</p>
      ${paragraphs(6, 'Body')}
      <figure><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/lazy.jpg" alt="Lazy figure" width="800" height="600">
        <figcaption>A lazily loaded figure</figcaption></figure>
      <p><img src="/img/small.jpg" srcset="/img/small.jpg 400w, /img/large.jpg 1600w, /img/huge.jpg 4000w" alt="Responsive" width="1600" height="900"></p>
      <p><img src="https://tracker.example.test/pixel.gif" width="1" height="1" alt=""></p>
      <h2>Evidence</h2>
      <table><thead><tr><th>Study</th><th>Result</th></tr></thead>
        <tbody><tr><td>First | trial</td><td>Persisted longer</td></tr><tr><td>Second</td><td>Same</td></tr></tbody></table>
      <table><tr><td colspan="2">Merged heading</td></tr><tr><td>Left</td><td>Right</td></tr></table>
      <pre><code class="language-python">print("endorse")</code></pre>
      <blockquote><p>Quoted words <del>removed</del> remain.</p></blockquote>
      <p onclick="window.clicked = 1" style="color: red">Inline handler paragraph.</p>
      <script>window.injected = 1</script><style>p { color: red }</style>
      <iframe src="https://video.example.test/embed/1" title="Talk"></iframe>
      <p id="fn1">1. The footnote text.</p>
      ${paragraphs(3, 'Closing')}
    </article></main>
    <footer><p>Copyright Fixture Blog. All rights reserved.</p></footer></body></html>`,
  '/short': `<!doctype html><html><head><title>Short page</title></head><body>
    <main><p>Only a few words here.</p></main></body></html>`,
  // About 5 MB of UTF-8 (Chinese text is three bytes a character): over both limits.
  '/huge': `<!doctype html><html lang="zh"><head><title>长文</title></head><body><main><article><h1>长文</h1>${Array.from(
    { length: 28000 },
    (_, i) =>
      `<p>第 ${i} 段：自主是对自己行动的认同，而不是独立于他人。读者会反复回到困难的段落，记下自己的理解。认同的目标能坚持得更久。</p>`,
  ).join('')}</article></main></body></html>`,
};
// X fixtures are served at their x.com addresses (nothing reaches the network).
const xPages = {
  'https://x.com/author/status/100': xThread(),
  'https://x.com/home': xThread(),
  // The layout X shows visitors who are not logged in: a real page's structure (captured
  // 2026-10-21 from a public post), with generated people, ids and text (see the fixture).
  'https://x.com/fixtureauthor/status/1900000000000000001': fs.readFileSync(
    path.join(__dirname, 'fixtures/x-logged-out.html'),
    'utf8',
  ),
  // A post page in a layout Tabgent does not know.
  'https://x.com/someone/status/5': `<!doctype html><html><head><title>X</title></head><body><main>
    <h1>A post</h1><ul><li><p>Post text that cannot be told apart from replies.</p></li>
    <li><p>Somebody else's reply.</p></li></ul></main></body></html>`,
};
// A synthetic X conversation page: the structure X renders, with generated text.
function xThread() {
  const tweet = (id, name, handle, text, extra = '') => `
    <div data-testid="cellInnerDiv"><article data-testid="tweet" tabindex="0">
      <div data-testid="User-Name"><a href="/${handle}" role="link"><span>${name}</span></a>
        <a href="/${handle}" role="link"><span>@${handle}</span></a>
        <a href="/${handle}/status/${id}"><time datetime="2026-10-0${id % 9}T10:00:00.000Z">Oct ${id % 9}</time></a></div>
      <div data-testid="tweetText" lang="en"><span>${text}</span></div>${extra}
    </article></div>`;
  return `<!doctype html><html lang="en"><head><title>Fixture Author on X: "Thread" / X</title></head><body>
    <main role="main"><div data-testid="primaryColumn"><section aria-labelledby="accessible-list-1">
      <h1 id="accessible-list-1">Conversation</h1><div>
      ${tweet(
        100,
        'Fixture Author',
        'author',
        'Autonomy is endorsement, not independence. A long thread about motivation follows here with enough words to read. <img alt="🔥" src="https://abs-0.twimg.com/emoji/v2/svg/1f525.svg">',
        '<div data-testid="tweetPhoto"><img alt="Chart" src="https://pbs.twimg.com/media/FIXTURE?format=jpg&name=small"></div>',
      )}
      ${tweet(101, 'Fixture Author', 'author', 'Second post in the thread: endorsed goals persist for longer than imposed ones.')}
      ${tweet(102, 'Fixture Author', 'author', 'Third post in the thread: autonomy support helps people keep going.')}
      ${tweet(103, 'Someone Else', 'other', 'A reply from another account that should not be clipped.')}
      </div></section></div></main></body></html>`;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const requests = [];
    await page.route('https://clip.test/**', (route) => {
      const url = new URL(route.request().url());
      if (pages[url.pathname])
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: pages[url.pathname],
        });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.route('https://x.com/**', (route) => {
      const body = xPages[route.request().url()];
      if (body) return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
      return route.abort();
    });
    await page.route(/^(?!https:\/\/(?:clip\.test|x\.com)\/)/, (route) => route.abort());
    async function open(pathname) {
      await page.goto(pathname.startsWith('https://') ? pathname : 'https://clip.test' + pathname);
      await page.evaluate(() => {
        globalThis.chrome = {
          i18n: {
            getMessage: (key, values) => (values?.length ? `${key}(${values.join('|')})` : key),
            getUILanguage: () => 'en',
          },
        };
      });
      for (const file of files) await page.addScriptTag({ path: file });
      await page.waitForTimeout(50);
      requests.length = 0;
      page.removeAllListeners('request');
      page.on('request', (request) => requests.push(request.url()));
    }
    const run = (options) => page.evaluate((o) => globalThis.tabgentClip.run(o), options);

    // An article: the main text, metadata, Markdown structure and cleaned HTML.
    await open('/blog/autonomy');
    const before = await page.evaluate(() => document.body.outerHTML);
    const article = await run({ mode: 'article', url: 'https://clip.test/blog/autonomy' });
    assert.equal(article.ok, true, JSON.stringify(article));
    const after = await page.evaluate(() => document.body.outerHTML);
    if (after !== before) {
      let i = 0;
      while (after[i] === before[i]) i++;
      console.log(
        'DIFF',
        JSON.stringify(before.slice(i - 80, i + 120)),
        '\n=>',
        JSON.stringify(after.slice(i - 80, i + 120)),
      );
    }
    assert.equal(after, before);
    assert.deepEqual(requests, [], 'clipping fetches nothing');
    assert.equal(article.title, 'On Autonomy');
    assert.equal(article.byline, 'Fixture Author');
    assert.equal(article.siteName, 'Fixture Blog');
    assert.match(article.publishedAt, /^2026-10-01/);
    assert.equal(article.language, 'en');
    assert.equal(article.tooLittle, false);
    const md = article.markdown;
    assert.match(md, /Autonomy is the endorsement of one's own actions\./);
    assert.match(md, /\[Read the notes\]\(https:\/\/clip\.test\/notes\/endorsement\)/);
    assert.match(md, /\[footnote\]\(#fn1\)/);
    assert.doesNotMatch(md, /javascript:/);
    assert.match(md, /^## Evidence$/m);
    assert.match(
      md,
      /\| Study \| Result \|\n\| --- \| --- \|\n\| First \\\| trial \| Persisted longer \|/,
    );
    assert.match(md, /Merged heading\n\nLeft · Right/);
    assert.match(md, /```python\nprint\("endorse"\)\n```/);
    assert.match(md, /~~removed~~/);
    // Images are placeholders named by a per-clip token; the worker fills them in.
    assert.match(article.imageToken, /^[0-9a-f]{32}$/);
    const image = (n) => `\\(tabgent-image-${article.imageToken}-${n}\\)`;
    assert.match(md, new RegExp(`!\\[Lazy figure\\]${image(0)}`));
    assert.match(md, new RegExp(`!\\[Responsive\\]${image(1)}`));
    assert.match(
      md,
      /\[clipEmbedded\(video\.example\.test\)\]\(https:\/\/video\.example\.test\/embed\/1\)/,
    );
    assert.doesNotMatch(md, /pixel\.gif|Sign up|Copyright|Archive/);
    assert.deepEqual(
      article.images.map((image) => image.url),
      ['https://clip.test/img/lazy.jpg', 'https://clip.test/img/large.jpg'],
    );
    const html = article.html;
    assert.doesNotMatch(
      html,
      /<script|<style|onclick|style=|<iframe|<form|<input|javascript:|\ssrc=/i,
    );
    assert.match(html, /<img[^>]+data-remote-src="https:\/\/clip\.test\/img\/lazy\.jpg"/);
    assert.ok(article.words > 150, article.words);

    // The whole page: the body without navigation, headers, footers and asides.
    const whole = await run({ mode: 'page', url: 'https://clip.test/blog/autonomy' });
    assert.equal(whole.ok, true);
    assert.match(whole.markdown, /Body paragraph 1 [\s\S]*Closing paragraph 3/);
    assert.equal(whole.tooLittle, false);
    assert.deepEqual(requests, []);

    // A selection clips only the selected text.
    await page.evaluate(() => {
      const range = document.createRange();
      const paragraph = [...document.querySelectorAll('article p')].find((p) =>
        p.textContent.includes('Body paragraph 2'),
      );
      range.selectNodeContents(paragraph);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    const selected = await run({ mode: 'selection', url: 'https://clip.test/blog/autonomy' });
    assert.equal(selected.ok, true);
    assert.equal(selected.extractor, 'selection');
    assert.match(selected.markdown, /^Body paragraph 2 explains/);
    assert.doesNotMatch(selected.markdown, /Body paragraph 3/);
    assert.equal(selected.title, 'On Autonomy | Fixture Blog');
    await page.evaluate(() => getSelection().removeAllRanges());
    assert.deepEqual(await run({ mode: 'selection', url: 'https://clip.test/blog/autonomy' }), {
      ok: false,
      reason: 'no-selection',
    });

    // A short page asks for a fallback.
    await open('/short');
    const short = await run({ mode: 'article', url: 'https://clip.test/short' });
    assert.equal(short.ok, true);
    assert.equal(short.tooLittle, true);
    assert.equal(short.hasSelection, false);

    // A very long page is cut at a paragraph break to the vault's limits, and says so.
    await open('/huge');
    const huge = await run({ mode: 'article', url: 'https://clip.test/huge' });
    assert.equal(huge.ok, true);
    assert.equal(huge.truncated, true);
    const size = (value) => Buffer.byteLength(value, 'utf8');
    assert(size(huge.html) <= 4 * 1024 * 1024, size(huge.html));
    assert(size(huge.markdown) <= 3 * 1024 * 1024, size(huge.markdown));
    assert.match(huge.markdown, /\*clipTruncated\*$/);
    assert.match(huge.html, /<em>clipTruncated<\/em><\/p>$/);

    // An X conversation: the author's thread, not other replies; large images; emoji as text.
    await open('https://x.com/author/status/100');
    const thread = await run({ mode: 'article', url: 'https://x.com/author/status/100' });
    assert.equal(thread.ok, true, JSON.stringify(thread));
    assert.equal(thread.extractor, 'x');
    assert.match(thread.markdown, /Autonomy is endorsement, not independence\./);
    assert.match(thread.markdown, /🔥/);
    assert.match(thread.markdown, /Second post in the thread/);
    assert.match(thread.markdown, /Third post in the thread/);
    assert.doesNotMatch(thread.markdown, /should not be clipped/);
    assert.deepEqual(
      thread.images.map((image) => image.url),
      ['https://pbs.twimg.com/media/FIXTURE?format=jpg&name=large'],
    );
    assert.match(
      thread.markdown,
      new RegExp(`!\\[Chart\\]\\(tabgent-image-${thread.imageToken}-0\\)`),
    );
    assert.notEqual(thread.imageToken, article.imageToken);
    assert.equal(thread.posts, 3);
    // A short title: the author and how the post starts, not the page title.
    assert.equal(
      thread.title,
      'Fixture Author on X: "Autonomy is endorsement, not independence. A long thread about motivation…"',
    );
    assert.deepEqual(requests, []);

    // The logged-out layout (no data-testid): the post once, its image, the author's own
    // reply right after it; not other people's replies, the author's later post after them,
    // counts, buttons or the screen-reader heading that repeats the whole post.
    const visitorUrl = 'https://x.com/fixtureauthor/status/1900000000000000001';
    await open(visitorUrl);
    const visitor = await run({ mode: 'article', url: visitorUrl });
    assert.equal(visitor.ok, true, JSON.stringify(visitor).slice(0, 300));
    assert.equal(visitor.extractor, 'x');
    assert.equal(
      visitor.title,
      'Fixture Author on X: "Fixture post: a new way of writing software where you describe what you want and…"',
    );
    assert.equal(visitor.byline, 'Fixture Author (@fixtureauthor)');
    assert.equal(visitor.markdown.match(/Fixture post: a new way/g).length, 1);
    assert.match(visitor.markdown, /weekend projects 😀\n\nSecond paragraph of the fixture post/);
    assert.match(visitor.markdown, /Second post by the author, continuing the thread/);
    assert.doesNotMatch(visitor.markdown, /should not be clipped|not part of the thread/);
    assert.doesNotMatch(
      visitor.markdown,
      /^#|发帖|显示翻译|X 上的|1474|3633|3\.4万|737\.1万|浏览量/m,
    );
    assert.equal(visitor.posts, 2);
    assert.equal(visitor.tooLittle, false);
    assert.deepEqual(
      visitor.images.map((image) => image.url),
      ['https://pbs.twimg.com/media/FIXTUREMEDIA?format=webp&name=large'],
    );
    assert.deepEqual(requests, []);
    // Another post layout is refused: generic extraction would mix in replies.
    await open('https://x.com/someone/status/5');
    assert.deepEqual(await run({ mode: 'article', url: 'https://x.com/someone/status/5' }), {
      ok: false,
      reason: 'x-layout',
    });
    // Saving the whole page stays possible, as the user's explicit choice.
    assert.equal((await run({ mode: 'page', url: 'https://x.com/someone/status/5' })).ok, true);
    // Timelines and profiles are not clipped as articles.
    await open('https://x.com/home');
    assert.deepEqual(await run({ mode: 'article', url: 'https://x.com/home' }), {
      ok: false,
      reason: 'x-not-post',
    });

    // A page that moved to another address (a single-page app) is not clipped under the old
    // one; the fragment does not count.
    assert.deepEqual(await run({ mode: 'article', url: 'https://x.com/author/status/100' }), {
      ok: false,
      reason: 'navigated',
    });
    assert.equal(
      (await run({ mode: 'article', url: 'https://x.com/home#top' })).reason,
      'x-not-post',
    );
    // A selection clip needs the quote the user chose to be selected still.
    await open('/blog/autonomy');
    await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('article p')].find((p) =>
        p.textContent.includes('Body paragraph 2'),
      );
      getSelection().selectAllChildren(paragraph);
    });
    const url = 'https://clip.test/blog/autonomy';
    assert.equal(
      (await run({ mode: 'selection', url, expected: 'Body paragraph 2 explains why' })).ok,
      true,
    );
    assert.deepEqual(await run({ mode: 'selection', url, expected: 'Body paragraph 5 explains' }), {
      ok: false,
      reason: 'no-selection',
    });
    // The Markdown cut: at a paragraph, else a line; never inside a surrogate pair; an open
    // code fence is closed before the note.
    const cut = (markdown, cap) =>
      page.evaluate(([m, c]) => globalThis.tabgentClip.cutMarkdown(m, c), [markdown, cap]);
    const paragraphsCut = await cut(
      `${'First paragraph. '.repeat(150)}\n\n${'Second. '.repeat(500)}`,
      4000,
    );
    assert.equal(paragraphsCut.truncated, true);
    assert.match(paragraphsCut.markdown, /^First paragraph\.[\s\S]*\n\n\*clipTruncated\*$/);
    const emoji = await cut('🔥'.repeat(3000), 5000);
    assert(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji.markdown), 'No lone surrogate');
    const fenced = await cut(`Intro.\n\n\`\`\`js\n${'const line = 1;\n'.repeat(2000)}`, 6000);
    assert.match(fenced.markdown, /\nconst line = 1;\n?\n\`\`\`\n\n\*clipTruncated\*$/);
    assert.deepEqual(await cut('Short.', 6000), { markdown: 'Short.', truncated: false });
    // X titles: 80 characters of the post. Chinese and Japanese are cut by characters even
    // with an early space; a cut inside an English word moves back to its space; a long word
    // without spaces, and an emoji at the cut, are not torn.
    const xTitle = (name, text) =>
      page.evaluate(([n, t]) => globalThis.tabgentClip.xTitle(n, t), [name, text]);
    const chinese =
      'GPT-5 发布了，这是第一印象：推理速度比上一代快很多，长文本理解更稳定，写代码时会主动检查边界条件，但偶尔还是会过度自信地给出错误的结论，需要人工复核。整体来说值得升级，尤其是做长文档总结和代码审查的时候。';
    const chineseTitle = await xTitle('某人', chinese);
    assert.equal(chineseTitle, `某人 on X: "${[...chinese].slice(0, 80).join('')}…"`);
    const early = await xTitle(
      '某人',
      '今天 OpenAI 发布了新的推理模型，' + '它在数学和代码上的表现都比之前好很多。'.repeat(4),
    );
    assert.match(early, /^某人 on X: "今天 OpenAI 发布了新的推理模型，它在数学和代码上的表现/);
    assert.equal([...early.slice('某人 on X: "'.length, -2)].length, 80);
    const japanese =
      'Claude 4 を試してみました。長い文章の要約がとても自然で、コードの説明も分かりやすいです。ただし、最新の情報には弱いので、検索と組み合わせるのが良さそうです。しばらく日常の作業で使ってみます。';
    const japaneseTitle = await xTitle('誰か', japanese);
    assert.equal(japaneseTitle, `誰か on X: "${[...japanese].slice(0, 80).join('')}…"`);
    const english =
      "There's a new kind of coding I call vibe coding, where you fully give in to the vibes and forget the code exists.";
    assert.equal(
      await xTitle('Someone', english),
      `Someone on X: "There's a new kind of coding I call vibe coding, where you fully give in to the…"`,
    );
    const long = 'Look: ' + 'a'.repeat(120);
    assert.equal(await xTitle('Someone', long), `Someone on X: "Look: ${'a'.repeat(74)}…"`);
    const family = 'x'.repeat(79) + '👨‍👩‍👧' + ' more text after the emoji';
    assert.equal(await xTitle('Someone', family), `Someone on X: "${'x'.repeat(79)}👨‍👩‍👧…"`);
    assert.equal(await xTitle('Someone', 'Short post.'), 'Someone on X: "Short post."');
    // A cap of zero or less ends at once with no text, never in a loop.
    for (const cap of [0, -5000]) {
      const empty = await cut('Some text.\n\nMore text.', cap);
      assert.equal(empty.truncated, true);
      assert(!empty.markdown.includes('text'), JSON.stringify(empty));
    }
    // Hundreds of uses of one long image address: the page is clipped quickly and within the
    // limit, its text kept.
    await open('/many-images');
    const startedMany = Date.now();
    const many = await run({ mode: 'page', url: 'https://clip.test/many-images' });
    assert(Date.now() - startedMany < 20000, `took ${Date.now() - startedMany} ms`);
    assert.equal(many.ok, true, JSON.stringify(many).slice(0, 300));
    assert.match(many.markdown, /A paragraph about the images/);
    assert(Buffer.byteLength(many.markdown) <= 3 * 1024 * 1024);
    assert.equal(many.images.filter((image) => image.url).length, 1);

    // The prompt resolves with the chosen action; Escape cancels.
    const choice = page.evaluate(() =>
      globalThis.tabgentClip.ask({ kind: 'replace', clippedAt: '2026-10-12T09:30:00+08:00' }),
    );
    await page.waitForTimeout(50);
    await page.keyboard.press('Escape');
    assert.equal(await choice, 'cancel');
    console.log('PASS clip extraction: article, page, selection, short page and X thread');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
