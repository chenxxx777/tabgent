// Clipping extraction on generated pages: Defuddle, the shared sanitizer settings and
// Turndown run in the page as the service worker injects them. Covers lazy images, tables
// (data, nested, layout, ARIA and CSS grids), code, links, embeds, unsafe markup, author and
// guest cards, the coverage check, a synthetic X thread, X timelines, selections, the
// whole-page fallback, short pages, figure captions, pages of only links, and the author,
// date and cover with their sources. Real pages' structure comes from de-identified
// fixtures (Meituan, WeChat, Anthropic's evals article, a Substack guest post). Nothing is
// fetched by the clipping script.
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
  'clip/clip-structure.js',
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
  // Tables of every shape: data, a layout table holding a data table, a data table with a
  // table in a cell, layout tables, an ARIA grid (with display: contents in a cell) and a
  // CSS grid of divs (no table semantics: its text stays, in reading order).
  '/tables': `<!doctype html><html lang="en"><head><title>Table shapes</title>
    <style>.grid { display: grid; grid-template-columns: repeat(3, 1fr) } .wrap { display: contents }</style>
    </head><body><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav><main><article>
    <h1>Table shapes</h1>${paragraphs(4, 'Intro')}
    <h2>Plain table</h2>
    <table><thead><tr><th>Plan</th><th>Price</th></tr></thead>
      <tbody><tr><td>Basic</td><td>Free</td></tr><tr><td>Team</td><td>$8 a seat</td></tr></tbody></table>
    <h2>Nested tables</h2>
    <table><tr><td><p>Quarterly results, as reported:</p><table><thead><tr><th>Quarter</th><th>Revenue</th></tr></thead>
      <tbody><tr><td>Q1</td><td>120</td></tr><tr><td>Q2</td><td>135</td></tr></tbody></table></td></tr></table>
    <table><thead><tr><th>Region</th><th>Details</th></tr></thead>
      <tbody><tr><td>North</td><td><table><tr><td>Stores</td><td>12</td></tr><tr><td>Staff</td><td>40</td></tr></table></td></tr></tbody></table>
    <h2>Layout tables</h2>
    <table role="presentation" width="600"><tr>
      <td><p>Left column: the layout table places this paragraph beside the next one.</p></td>
      <td><p>Right column: a second paragraph that only sits beside the first for looks.</p></td></tr></table>
    <table><tr><td></td><td>A spacer cell, then the only filled cell, with a note about the layout.</td><td></td></tr></table>
    <h2>ARIA grid</h2>
    <div role="grid" aria-label="Schedule">
      <div role="rowgroup"><div role="row"><span role="columnheader">Day</span><span role="columnheader">Session</span></div></div>
      <div role="rowgroup"><div role="row"><span role="rowheader">Monday</span><span role="gridcell"><span class="wrap">Opening talk</span></span></div>
      <div role="row"><span role="rowheader">Tuesday</span><span role="gridcell">Workshops</span></div></div></div>
    <h2>CSS grid</h2>
    <div class="grid"><div><b>Feature</b></div><div><b>Basic</b></div><div><b>Team</b></div>
      <div>Exports</div><div>Monthly</div><div>Daily</div></div>
    ${paragraphs(2, 'Closing')}</article></main></body></html>`,
  // An author card and a guest card in the article's footer are kept; the byline, sharing
  // counts, related posts, comments and navigation are not.
  '/cards': `<!doctype html><html lang="en"><head><title>On Reading Slowly</title>
    <meta name="author" content="Jane Fixture"></head><body>
    <header class="site-header"><nav><a href="/">Home</a> <a href="/topics">Topics</a></nav></header>
    <main><article class="post">
      <header class="entry-header"><h1>On Reading Slowly</h1>
        <div class="byline">By <a href="/author/jane">Jane Fixture</a> · Oct 3, 2026 · 6 min read</div></header>
      <div class="entry-content">${paragraphs(8, 'Slow')}</div>
      <div class="share-bar"><button>Share</button> <a href="https://social.example.test/share">Post it</a>
        <span class="count">128</span> <span class="likes">42 likes</span></div>
      <footer class="entry-footer">
        <div class="author-bio"><img src="/img/jane.jpg" alt="Jane Fixture" width="64" height="64">
          <div><h4>About the author</h4><p>Jane Fixture writes about reading habits and the history of
          the book. Her newsletter covers slow reading practices.</p></div></div>
        <div class="guest-card">A guest post by <a href="/@sam">Sam Guest</a>, editor of the Fixture Review.</div>
      </footer>
      <section class="related-posts"><h3>Related posts</h3><ul><li><a href="/p/1">Reading with a pencil</a></li>
        <li><a href="/p/2">Why margins matter</a></li></ul></section>
      <section id="comments" class="comments"><h3>3 comments</h3>
        <div class="comment"><p>Great essay, I agree with the point about rereading difficult passages.</p></div></section>
    </article></main>
    <footer class="site-footer"><p>© 2026 Fixture Press</p></footer></body></html>`,
  // A comparison drawn as cards: Defuddle drops elements named "card-content", although the
  // page shows them. The coverage check puts them back where they were.
  '/coverage': `<!doctype html><html lang="en"><head><title>Field notes</title>
    <style>.compare { display: grid; grid-template-columns: repeat(3, 1fr) }</style></head><body>
    <main><article><h1>Field notes</h1>${paragraphs(6, 'Field')}
    <div class="compare">
      <div class="card"><div class="card-content"><h3>Morning series</h3><p>Taken at six, before
        the wind rises; the readings are steady and agree with the earlier field season.</p></div></div>
      <div class="card"><div class="card-content"><h3>Night series</h3><p>Taken at ten, after the
        ground cools; about four percent lower than the morning readings on most days.</p></div></div>
      <div class="card"><div class="card-content"><h3>Both together</h3><p>Read the figures as ranges,
        not exact values, before drawing conclusions about the trend over the decade.</p></div></div>
    </div>
    ${paragraphs(4, 'Later')}</article></main></body></html>`,
  // Figures: a caption after its image, a caption before it, and a quote with a caption.
  '/figures': `<!doctype html><html lang="en"><head><title>Figures</title></head><body><main><article>
    <h1>Figures</h1>${paragraphs(4, 'Opening')}
    <figure><img src="/img/chart.png" alt="Chart" width="800" height="500">
      <figcaption><div>Components of an evaluation.</div></figcaption></figure>
    ${paragraphs(2, 'Middle')}
    <figure><figcaption>Results <em>by group</em>, before the image.</figcaption>
      <a href="/img/second-large.png"><img src="/img/second.png" alt="" width="800" height="500"></a></figure>
    <figure><blockquote><p>A quoted line about readers.</p></blockquote><figcaption>A source of the quote</figcaption></figure>
    ${paragraphs(2, 'Closing')}</article></main></body></html>`,
  // A page that is only an embedded video: its cover is the page's og:image.
  '/video': `<!doctype html><html lang="en"><head><title>A recorded talk</title>
    <meta property="og:image" content="/img/poster.jpg"></head><body><main>
    <h1>A recorded talk</h1><iframe src="https://video.example.test/embed/talk" title="Talk"></iframe>
    </main></body></html>`,
  // A Chinese post whose author and date are only in the line under its title.
  '/zh-post': `<!doctype html><html lang="zh-CN"><head><title>示例文章</title></head><body><main><article>
    <h1>示例文章</h1><div class="post-meta"><span class="post-author">作者：王小明</span>
    <span class="publish-date">发布于 2026年3月5日 21:00</span><span class="reading-time">阅读 5 分钟</span></div>
    ${Array.from({ length: 6 }, (_, i) => `<p>第 ${i + 1} 段：读者会反复回到困难的段落，记下自己的理解，并把问题和想法写成笔记，留待以后再读。</p>`).join('')}
    </article></main></body></html>`,
  // An English date as text: Defuddle reads it as midnight UTC; it is kept as a date.
  '/dated': `<!doctype html><html lang="en"><head><title>Dated</title></head><body><main><article>
    <h1>Dated</h1><p>March 5, 2026</p>${paragraphs(5, 'Dated')}</article></main></body></html>`,
  // About 5 MB of UTF-8 (Chinese text is three bytes a character): over both limits.
  '/huge': `<!doctype html><html lang="zh"><head><title>长文</title></head><body><main><article><h1>长文</h1>${Array.from(
    { length: 28000 },
    (_, i) =>
      `<p>第 ${i} 段：自主是对自己行动的认同，而不是独立于他人。读者会反复回到困难的段落，记下自己的理解。认同的目标能坚持得更久。</p>`,
  ).join('')}</article></main></body></html>`,
};
// Pages of sites with their own layout rules, served at their addresses: the structure of
// real pages (captured 2026-10-21), with generated names, text, ids and images.
const sitePages = {
  'https://tech.meituan.com/2026/08/07/fixture.html': fs.readFileSync(
    path.join(__dirname, 'fixtures/meituan-tech.html'),
    'utf8',
  ),
  'https://mp.weixin.qq.com/s/FIXTUREfixture0001': fs.readFileSync(
    path.join(__dirname, 'fixtures/wechat-article.html'),
    'utf8',
  ),
  // Anthropic's "Demystifying evals" (comparison tables drawn with ARIA roles, their cell
  // text in display: contents wrappers) and a Substack guest post (a guest card in nested
  // layout tables; a space only in "<strong> </strong>"). See each fixture's first comment.
  'https://www.anthropic.com/research/demystifying-evals-for-ai-agents': fs.readFileSync(
    path.join(__dirname, 'fixtures/anthropic-evals.html'),
    'utf8',
  ),
  'https://fixturehost.substack.com/p/the-human-interfaces-of-data-guest': fs.readFileSync(
    path.join(__dirname, 'fixtures/substack-guest-post.html'),
    'utf8',
  ),
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
    await page.route(
      /^https:\/\/(?:tech\.meituan\.com|mp\.weixin\.qq\.com|www\.anthropic\.com|fixturehost\.substack\.com)\//,
      (route) => {
        const body = sitePages[route.request().url()];
        if (body) return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
        return route.abort();
      },
    );
    await page.route(
      /^(?!https:\/\/(?:clip\.test|x\.com|tech\.meituan\.com|mp\.weixin\.qq\.com|www\.anthropic\.com|fixturehost\.substack\.com)\/)/,
      (route) => route.abort(),
    );
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
    // The page's text is all in the clip: nothing to put back.
    assert.equal(article.coverage.restoredPassages, 0);
    assert(article.coverage.ratio >= 0.95, JSON.stringify(article.coverage));
    // Its metadata came from the page's meta tags; it has no cover image, and it is text.
    assert.deepEqual(article.metaSources, {
      author: 'metadata',
      publishedAt: 'metadata',
      siteName: 'metadata',
    });
    assert.equal(article.cover, '');
    assert.equal(article.contentStatus, 'text');
    // A figure's caption stays in the HTML as a figcaption, and right under its image in
    // the Markdown.
    assert.match(
      html,
      /<figure>[\s\S]*<img[^>]+lazy\.jpg[\s\S]*<figcaption>A lazily loaded figure<\/figcaption><\/figure>/,
    );
    assert.match(md, new RegExp(`!\\[Lazy figure\\]${image(0)}\n\\*A lazily loaded figure\\*\n\n`));

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

    // A short page asks for a fallback; a few words without links are still its text.
    await open('/short');
    const short = await run({ mode: 'article', url: 'https://clip.test/short' });
    assert.equal(short.ok, true);
    assert.equal(short.tooLittle, true);
    assert.equal(short.hasSelection, false);
    assert.equal(short.contentStatus, 'text');

    // Figures keep each caption right under its image (Defuddle puts a caption the page
    // shows first after the image, as text); a quote's caption stays its own paragraph (a
    // line right after a quote would join it).
    await open('/figures');
    const figures = await run({ mode: 'article', url: 'https://clip.test/figures' });
    assert.equal(figures.ok, true);
    const figure = (n) => `\\(tabgent-image-${figures.imageToken}-${n}\\)`;
    assert.match(
      figures.markdown,
      new RegExp(`\n\n!\\[Chart\\]${figure(0)}\n\\*Components of an evaluation\\.\\*\n\n`),
    );
    assert.match(
      figures.markdown,
      new RegExp(`\n\n!\\[\\]${figure(1)}\n\\*Results by group, before the image\\.\\*\n\n`),
    );
    assert.match(figures.markdown, /> A quoted line about readers\.\n\nA source of the quote/);
    // HTML that is not run through Defuddle (a feed item) keeps a caption the page puts
    // first before its image, and a linked image's link; a caption with emphasis is not
    // wrapped in more.
    const feedFigures = await page.evaluate(() =>
      globalThis.tabgentClip.clean({
        kind: 'feed',
        url: 'https://clip.test/feed-item',
        html: `<p>Intro.</p><figure><figcaption>Results <em>by group</em>.</figcaption>
          <a href="/img/second-large.png"><img src="/img/second.png" alt=""></a></figure><p>After.</p>`,
      }),
    );
    assert.match(
      feedFigures.markdown,
      new RegExp(
        `Intro\\.\n\nResults \\*by group\\*\\.\n\\[!\\[\\]\\(tabgent-image-${feedFigures.imageToken}-0\\)\\]\\(https://clip\\.test/img/second-large\\.png\\)\n\nAfter\\.`,
      ),
    );
    assert.equal((figures.html.match(/<figcaption>/g) || []).length, 3);

    // Only an embedded video: the clip says it holds only links, in article and whole-page
    // mode, and the page's og:image is its cover.
    await open('/video');
    for (const mode of ['article', 'page']) {
      const video = await run({ mode, url: 'https://clip.test/video' });
      assert.equal(video.ok, true);
      assert.equal(video.contentStatus, 'linksOnly', mode);
      assert.equal(video.cover, 'https://clip.test/img/poster.jpg');
      assert.equal(video.metaSources.cover, 'metadata');
      assert.equal(video.tooLittle, mode === 'article');
    }
    assert.deepEqual(requests, []);

    // A Chinese post: the author and date from the line under its title, the date as the
    // date the page shows (no time zone is invented for it).
    await open('/zh-post');
    const zh = await run({ mode: 'article', url: 'https://clip.test/zh-post' });
    assert.equal(zh.byline, '王小明');
    assert.equal(zh.publishedAt, '2026-03-05');
    assert.equal(zh.metaSources.author, 'title-line');
    assert.equal(zh.metaSources.publishedAt, 'title-line');
    // A date Defuddle reads from text (midnight UTC) is kept as that date.
    await open('/dated');
    const dated = await run({ mode: 'article', url: 'https://clip.test/dated' });
    assert.equal(dated.publishedAt, '2026-03-05');
    assert.equal(dated.metaSources.publishedAt, 'metadata');

    // Meituan's tech blog: the team, the date and the cover from its post header. An image
    // followed by a paragraph keeps that paragraph as text in its place: it is not a caption.
    const meituanUrl = 'https://tech.meituan.com/2026/08/07/fixture.html';
    await open(meituanUrl);
    const meituan = await run({ mode: 'article', url: meituanUrl });
    assert.equal(meituan.ok, true, JSON.stringify(meituan).slice(0, 300));
    assert.equal(meituan.byline, '示例技术团队');
    assert.equal(meituan.publishedAt, '2026-08-07');
    assert.equal(meituan.cover, 'https://p1.meituan.net/fixture/cover-0001.jpg');
    assert.deepEqual(meituan.metaSources, {
      author: 'site:tech.meituan.com',
      publishedAt: 'site:tech.meituan.com',
      siteName: 'metadata',
      cover: 'site:tech.meituan.com',
    });
    const placeholder = (n) => `\\(tabgent-image-${meituan.imageToken}-${n}\\)`;
    assert.match(
      meituan.markdown,
      new RegExp(
        `!\\[\\]${placeholder(0)}\n\n图后的第一段正文：它解释上图，但不是图注，在原网页里就是一段普通正文。\n\n> 引用的一句话`,
      ),
    );
    assert.doesNotMatch(meituan.markdown, /\n\*图后的第一段/);
    assert.doesNotMatch(meituan.html, /<figcaption>/);
    assert.match(meituan.markdown, /第 1 段：引言[\s\S]*第 12 段：小结/);
    assert.equal(meituan.contentStatus, 'text');
    assert.deepEqual(requests, []);

    // A WeChat article: the publish time from the article's own data, in China time as
    // WeChat shows it (its element is empty until WeChat's script fills it); the author
    // from the author line, the cover from og:image.
    const wechatUrl = 'https://mp.weixin.qq.com/s/FIXTUREfixture0001';
    await open(wechatUrl);
    const wechat = await run({ mode: 'article', url: wechatUrl });
    assert.equal(wechat.ok, true, JSON.stringify(wechat).slice(0, 300));
    assert.equal(wechat.publishedAt, '2026-10-18T21:00:00+08:00');
    assert.equal(wechat.byline, '示例作者');
    assert.equal(wechat.cover, 'https://mmbiz.qpic.cn/sz_mmbiz_jpg/FIXTURECOVER/0?wx_fmt=jpeg');
    assert.deepEqual(wechat.metaSources, {
      author: 'site:mp.weixin.qq.com',
      publishedAt: 'site:mp.weixin.qq.com',
      siteName: 'metadata',
      cover: 'metadata',
    });
    // A selection has the page's author and date, but no cover.
    await page.evaluate(() =>
      getSelection().selectAllChildren(document.querySelector('#js_content p')),
    );
    const quote = await run({ mode: 'selection', url: wechatUrl });
    assert.equal(quote.ok, true);
    assert.equal(quote.cover, '');
    assert.equal(quote.publishedAt, '2026-10-18T21:00:00+08:00');
    assert.equal(quote.metaSources.cover, undefined);
    assert.equal(quote.contentStatus, 'text');
    await page.evaluate(() => getSelection().removeAllRanges());
    assert.deepEqual(requests, []);

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

    // Tables of every shape.
    await open('/tables');
    const shapes = await run({ mode: 'article', url: 'https://clip.test/tables' });
    assert.equal(shapes.ok, true, JSON.stringify(shapes).slice(0, 300));
    const sm = shapes.markdown;
    assert.match(
      sm,
      /\| Plan \| Price \|\n\| --- \| --- \|\n\| Basic \| Free \|\n\| Team \| \$8 a seat \|/,
    );
    // A layout table holding a data table: the text, then the data table.
    assert.match(
      sm,
      /Quarterly results, as reported:\n\n\| Quarter \| Revenue \|\n\| --- \| --- \|\n\| Q1 \| 120 \|\n\| Q2 \| 135 \|/,
    );
    // A table in a data table's cell: a line per row in the cell.
    assert.match(
      sm,
      /\| Region \| Details \|\n\| --- \| --- \|\n\| North \| Stores · 12 <br> Staff · 40 \|/,
    );
    // Layout tables: their paragraphs, in reading order, not a table.
    assert.match(sm, /Left column: the layout table[^\n]*\n\nRight column: a second paragraph/);
    assert.match(
      sm,
      /\n\nA spacer cell, then the only filled cell, with a note about the layout\.\n\n/,
    );
    // An ARIA grid is a table; the text inside display: contents is kept.
    assert.match(
      sm,
      /\| Day \| Session \|\n\| --- \| --- \|\n\| Monday \| Opening talk \|\n\| Tuesday \| Workshops \|/,
    );
    // A CSS grid has no rows to read: its text stays, in reading order.
    assert.match(
      sm,
      /\*\*Feature\*\*[\s\S]*\*\*Basic\*\*[\s\S]*\*\*Team\*\*[\s\S]*Exports[\s\S]*Monthly[\s\S]*Daily/,
    );
    assert.doesNotMatch(sm, /\| +\||Home|Docs/);
    assert.equal(shapes.coverage.restoredPassages, 0);
    assert.deepEqual(requests, []);

    // Author and guest cards stay; the byline, counts, sharing, related posts and comments do not.
    await open('/cards');
    const cards = await run({ mode: 'article', url: 'https://clip.test/cards' });
    assert.equal(cards.ok, true);
    const cm = cards.markdown;
    assert.match(
      cm,
      /Slow paragraph 8[^\n]*\n\n#### About the author\n\nJane Fixture writes about reading habits/,
    );
    assert.match(
      cm,
      /A guest post by \[Sam Guest\]\(https:\/\/clip\.test\/@sam\), editor of the Fixture Review\./,
    );
    assert.doesNotMatch(
      cm,
      /Related posts|Reading with a pencil|Great essay|3 comments|128|42 likes|Share|Post it|Home|Topics|min read|© 2026/,
    );
    assert.equal(cards.coverage.restoredPassages, 1);
    assert.deepEqual(requests, []);

    // Visible text the extractor dropped is put back in place, and the clip says so.
    await open('/coverage');
    const field = await run({ mode: 'article', url: 'https://clip.test/coverage' });
    assert.equal(field.ok, true);
    assert.match(
      field.markdown,
      /Field paragraph 6[^\n]*\n\n### Morning series\n\nTaken at six, before the wind rises;[^\n]*\n\n### Night series\n\n[^\n]+\n\n### Both together\n\nRead the figures as ranges,[^\n]*over the decade\.\n\nLater paragraph 1/,
    );
    assert.equal(field.coverage.restoredPassages, 1);
    assert(field.coverage.restoredChars > 300, JSON.stringify(field.coverage));
    assert(field.coverage.ratio < 0.9, JSON.stringify(field.coverage));
    assert.equal(field.coverage.incomplete, false);
    assert.match(field.html, /<h3>Morning series<\/h3>/);

    // 02: Anthropic's comparison tables (ARIA roles, cell text in display: contents) and the
    // acknowledgements, as on the page; no navigation, related articles or footer.
    const evalsUrl = 'https://www.anthropic.com/research/demystifying-evals-for-ai-agents';
    await open(evalsUrl);
    const evals = await run({ mode: 'article', url: evalsUrl });
    assert.equal(evals.ok, true, JSON.stringify(evals).slice(0, 300));
    assert.equal(evals.title, 'Demystifying evals for AI agents');
    const em = evals.markdown;
    assert.equal(
      em.match(
        /^\| \*\*Methods\*\* \| \*\*Strengths\*\* \| \*\*Weaknesses\*\* \|\n\| --- \| --- \| --- \|$/gm,
      )?.length,
      3,
    );
    assert.match(
      em,
      /## Code-based graders\n\n\| \*\*Methods\*\* [^\n]+\n\| --- \| --- \| --- \|\n\| • String match checks \(exact, regex, fuzzy, etc\.\) <br> • Binary tests \(fail-to-pass, pass-to-pass\) <br> [^\n]+ \| • Fast <br> • Cheap <br> • Objective <br> /,
    );
    assert.match(em, /\| - Rubric-based scoring <br> - Natural language assertions <br> /);
    assert.match(
      em,
      /\| Method \| Pros \| Cons \|\n\| --- \| --- \| --- \|\n\| \*\*Automated evals\*\* <br> \*Running tests programmatically without real users\* \| - Faster iteration <br> - Fully reproducible/,
    );
    for (const method of [
      'Production monitoring',
      'A\\/B testing',
      'User feedback',
      'Manual transcript review',
      'Systematic human studies',
    ])
      assert.match(em, new RegExp(`^\\| \\*\\*${method}\\*\\* <br> \\*`, 'm'));
    assert.match(
      em,
      /## Authors & Acknowledgments\n\n### Acknowledgements\n\nWritten by Fixture Writer One/,
    );
    assert.doesNotMatch(
      em,
      /Skip to main content|Try Claude|Related articles|Trustworthy agents in practice|© 2026 Anthropic/,
    );
    assert.equal((evals.html.match(/<table>/g) || []).length, 4);
    // Its figure captions stay under their images next to the tables (captions and tables
    // are handled independently).
    assert.equal((evals.html.match(/<figcaption>/g) || []).length, 5);
    assert.equal(
      em.match(
        new RegExp(`!\\[[^\\]]*\\]\\(tabgent-image-${evals.imageToken}-\\d+\\)\n\\*[^\n]+\\*`, 'g'),
      )?.length,
      5,
    );
    assert.equal(evals.contentStatus, 'text');
    assert.equal(evals.coverage.ratio, 1);
    assert.equal(evals.coverage.restoredPassages, 0);
    assert.deepEqual(requests, []);

    // 09: the Substack guest card is text, not a table of empty cells; spaces kept; no
    // subscribe box, sharing, counts, comments or more posts.
    const guestUrl = 'https://fixturehost.substack.com/p/the-human-interfaces-of-data-guest';
    await open(guestUrl);
    const guest = await run({ mode: 'article', url: guestUrl });
    assert.equal(guest.ok, true, JSON.stringify(guest).slice(0, 300));
    assert.equal(guest.title, 'The Human Interfaces of Data - Guest');
    const gm = guest.markdown;
    assert.match(
      gm,
      /\n\nA guest post by\n\n\[Fixture Guest\]\(https:\/\/substack\.com\/@fixtureguest\?utm_campaign=guest_post_bio&utm_medium=web\) {2}\nCEO, Fixture Labs/,
    );
    assert.doesNotMatch(gm, /\|/);
    assert.match(gm, /\*\*\*Fixture Guest -\*\* I test interface/);
    assert.doesNotMatch(
      gm,
      /Thanks for reading|Subscribe|Discussion about this post|Fixture Reader|Semantic Superiority|Ready for more|Restacks|Likes|^Share$/m,
    );
    assert.equal(guest.coverage.ratio, 1);
    assert.equal(guest.coverage.restoredPassages, 0);
    assert.deepEqual(requests, []);

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
    // X posts are their author's words: no page cover, never "only links".
    assert.equal(thread.cover, '');
    assert.equal(thread.contentStatus, 'text');
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
    console.log(
      'PASS clip extraction: article, page, selection, short page, X thread, captions, links only, metadata and cover, table shapes, cards, coverage and captured pages',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
