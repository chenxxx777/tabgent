// Clipping extraction on generated pages: Defuddle, the shared sanitizer settings and
// Turndown run in the page as the service worker injects them. Covers lazy images, tables
// (data, nested, layout, ARIA and CSS grids), code, links, embeds, unsafe markup, author and
// guest cards, the coverage check, a synthetic X thread, X timelines, selections, the
// whole-page fallback, short pages, figure captions, pages of only links, and the author,
// date and cover with their sources, YouTube captions saved as transcripts (generated watch
// pages and caption files) and podcast transcripts. Real pages' structure comes from
// de-identified fixtures (Meituan, WeChat, Anthropic's evals article, a Substack guest
// post). Only the clipping script's caption and transcript requests to the page's own site
// are made; nothing else is fetched.
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
  'clip/clip-media.js',
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
    <div role="grid" class="related-posts"><div role="row"><span role="gridcell"><a href="/p/9">Pencil notes for beginners</a></span>
      <span role="gridcell">5 min</span></div><div role="row"><span role="gridcell"><a href="/p/10">Margins that matter</a></span>
      <span role="gridcell">7 min</span></div></div>
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
        <div class="byline">By <a class="author" href="/author/jane">Jane Fixture</a>,
          <span class="author-role">Senior Reading Correspondent</span> · Oct 3, 2026 · 6 min read</div></header>
      <div class="entry-content">${paragraphs(8, 'Slow')}</div>
      <div class="share-bar"><button>Share</button> <a href="https://social.example.test/share">Post it</a>
        <span class="count">128</span> <span class="likes">42 likes</span></div>
      <footer class="entry-footer">
        <div class="author-bio"><img src="/img/jane.jpg" alt="Jane Fixture" width="64" height="64">
          <div><h4>About the author</h4><p>Jane Fixture writes about reading habits and the history of
          the book. Her newsletter covers slow reading practices.</p></div></div>
        <div class="guest-card">A guest post by <a href="/@sam">Sam Guest</a>, editor of the Fixture Review.</div>
        <div class="author-more"><h4>More from this author</h4><ul><li><a href="/p/3">Reading by lamplight in winter</a></li>
          <li><a href="/p/4">The slow annotation habit, revisited</a></li></ul></div>
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
  // A time the page states at midnight UTC is kept as that time.
  '/midnight': `<!doctype html><html lang="en"><head><title>Midnight</title>
    <meta property="article:published_time" content="2026-03-05T00:00:00Z"></head><body><main><article>
    <h1>Midnight</h1>${paragraphs(5, 'Midnight')}</article></main></body></html>`,
  // Chinese pages with an embedded video: a few characters around it are only links; a
  // paragraph of text is the page's text.
  '/zh-video': `<!doctype html><html lang="zh-CN"><head><title>演讲录像</title></head><body><main>
    <h1>演讲录像</h1><p>请看视频：</p><iframe src="https://video.example.test/embed/zh" title="视频"></iframe></main></body></html>`,
  '/zh-video-notes': `<!doctype html><html lang="zh-CN"><head><title>演讲录像与笔记</title></head><body><main>
    <h1>演讲录像与笔记</h1><p>这场演讲讨论了慢读如何改变读者记住的内容，以及笔记怎样帮助我们回到困难的段落。</p>
    <iframe src="https://video.example.test/embed/zh" title="视频"></iframe></main></body></html>`,
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
// YouTube watch pages and caption files (see fixtures/youtube.cjs).
const { youtubePage, youtubeCues, json3, srv3 } = require('./fixtures/youtube.cjs');
const chaptered = [
  'A fixture video about careful reading.',
  '',
  'Notes: https://clip.test/notes (and more at 2:30).',
  '',
  '0:00 Introduction',
  '1:00 The second part',
  '2:30 Closing words',
].join('\n');
const youtubePages = {
  // English captions of its own, an automatic track and another language: its own English.
  FIXTUREvid1: youtubePage('FIXTUREvid1', {
    tracks: [
      ['en', 'asr', 'English (auto-generated)'],
      ['en', '', 'English'],
      ['de', '', 'German'],
    ],
    description: chaptered,
  }),
  // Japanese automatic captions, answered only with the token the player adds.
  FIXTUREvid2: youtubePage('FIXTUREvid2', {
    tracks: [
      ['ja', 'asr', '日本語 (自動生成)'],
      ['en', '', 'English'],
    ],
    playerRequest: '/api/timedtext?v=FIXTUREvid2&lang=ja&kind=asr&pot=FIXTUREPOT&fmt=json3&c=WEB',
  }),
  // No caption text at all, but the user opened the transcript panel.
  FIXTUREvid3: youtubePage('FIXTUREvid3', {
    tracks: [['en', '', 'English']],
    panel: Array.from({ length: 12 }, (_, i) => [
      `0:${String(i * 4).padStart(2, '0')}`,
      `Panel line ${i + 1} about reading slowly.`,
    ]),
  }),
  // Tracks whose text YouTube does not return: only the description is saved.
  FIXTUREvid4: youtubePage('FIXTUREvid4', {
    tracks: [['en', 'asr', 'English (auto-generated)']],
    description: 'Show notes for the episode.\n\nGuests and links: https://clip.test/guests',
  }),
  // YouTube asks to sign in (or to confirm this is not a bot).
  FIXTUREvid5: youtubePage('FIXTUREvid5', {
    status: 'LOGIN_REQUIRED',
    description: 'A description that is still on the page.',
  }),
  // No captions and no description.
  FIXTUREvid6: youtubePage('FIXTUREvid6'),
  // A very long transcript.
  FIXTUREvid7: youtubePage('FIXTUREvid7', { tracks: [['en', '', 'English']] }),
  // The player shows another video: its data is not used for this one.
  FIXTUREvid8: youtubePage('FIXTUREvid8', { tracks: [['en', '', 'English']], current: false }),
};
function captions(url) {
  const id = url.searchParams.get('v'),
    pot = url.searchParams.has('pot');
  if (
    id === 'FIXTUREvid1' &&
    url.searchParams.get('lang') === 'en' &&
    !url.searchParams.get('kind')
  )
    return json3(
      youtubeCues(60, (i) =>
        i === 25 ? `Sentence ${i + 1} ends a thought.` : `Sentence ${i + 1} about careful reading`,
      ).map(([start, duration, text], i) => [start + (i >= 26 ? 5 : 0), duration, text]),
    );
  if (id === 'FIXTUREvid2' && pot) return srv3(youtubeCues(20, (i) => `日本語の字幕${i + 1}`));
  if (id === 'FIXTUREvid7')
    return json3(youtubeCues(40000, (i) => `Line ${i + 1} of a very long talk about reading.`, 1));
  return '';
}
// Podcast episode pages: show notes only; a transcript kept collapsed; a transcript on
// another page of the site; and an article that only offers an audio version.
const episode = (body, head = '') =>
  `<!doctype html><html lang="en"><head><title>Episode 12: Reading slowly</title>${head}
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"PodcastEpisode","name":"Episode 12"}</script>
  </head><body><main><article><h1>Episode 12: Reading slowly</h1>
  <audio controls src="/audio/episode-12.mp3"></audio>
  <h2>Show notes</h2>${paragraphs(5, 'Show notes')}${body}</article></main></body></html>`;
const transcriptText = (n) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p><strong>Host:</strong> Transcript line ${i + 1}, where the guest explains how slow reading changes what a reader remembers.</p>`,
  ).join('');
Object.assign(pages, {
  '/podcast/notes': episode(''),
  '/podcast/collapsed': episode(
    `<button aria-expanded="false">Show transcript</button><div class="episode-transcript" style="display: none">${transcriptText(8)}</div>`,
  ),
  // A visible transcript the extractor drops (Defuddle removes "card-content"), between
  // show notes: added once, as the transcript, not also put back by the coverage check.
  '/podcast/dropped': episode(
    `<div class="card-content episode-transcript">${transcriptText(6)}</div>${paragraphs(3, 'More notes')}`,
  ),
  '/podcast/linked': episode(
    '<p><a href="/podcast/linked/transcript">Read the full transcript</a></p>',
  ),
  '/podcast/linked/transcript': `<!doctype html><html lang="en"><head><title>Transcript</title></head><body><main><article><h1>Episode 12 transcript</h1>${transcriptText(10)}</article></main></body></html>`,
  '/listen': `<!doctype html><html lang="en"><head><title>An essay with audio</title></head><body><main><article>
    <h1>An essay with audio</h1><p>Listen to this article: <audio controls src="/audio/essay.mp3"></audio></p>${paragraphs(6, 'Essay')}
    </article></main></body></html>`,
});
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
    await page.route(/^https:\/\/www\.youtube\.com\//, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/watch' && youtubePages[url.searchParams.get('v')])
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: youtubePages[url.searchParams.get('v')],
        });
      if (url.pathname === '/api/timedtext')
        return route.fulfill({ contentType: 'text/plain; charset=utf-8', body: captions(url) });
      return route.abort();
    });
    await page.route(
      /^(?!https:\/\/(?:clip\.test|x\.com|tech\.meituan\.com|mp\.weixin\.qq\.com|www\.anthropic\.com|fixturehost\.substack\.com|www\.youtube\.com)\/)/,
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
    await open('/midnight');
    assert.equal(
      (await run({ mode: 'article', url: 'https://clip.test/midnight' })).publishedAt,
      '2026-03-05T00:00:00Z',
    );
    // Chinese counts each character as a word: a few characters around a video are links only.
    for (const [pathname, status] of [
      ['/zh-video', 'linksOnly'],
      ['/zh-video-notes', 'text'],
    ]) {
      await open(pathname);
      const zhVideo = await run({ mode: 'page', url: 'https://clip.test' + pathname });
      assert.equal(zhVideo.contentStatus, status, pathname);
    }

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
    // An ARIA grid named as related posts is noise, as the same grid of divs would be.
    assert.doesNotMatch(sm, /Pencil notes for beginners|Margins that matter/);
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
    // An author-named byline in the header is metadata, and a card of links ("More from this
    // author") is a link list: neither is put back, nor the title above them.
    assert.doesNotMatch(
      cm,
      /Senior Reading Correspondent|More from this author|lamplight|On Reading Slowly/,
    );
    assert.equal(cards.coverage.restoredPassages, 1);
    assert.deepEqual(requests, []);

    // A table row the extraction lost is put back in a table, its cells kept apart.
    const row = await page.evaluate(() => {
      const { coverage, restore } = globalThis.tabgentClipStructure;
      const long = (word) =>
        Array.from(
          { length: 6 },
          (_, i) => `${word} sentence ${i + 1} about careful reading.`,
        ).join(' ');
      const body = (lost) =>
        `<article><h1>Rows</h1>${[1, 2, 3, 4].map((i) => `<p>${long('Before ' + i)}</p>`).join('')}
        <table><tbody><tr><td>${long('Kept first')}</td><td>Kept</td></tr>
        ${lost ? '' : `<tr><td>${long('Lost row')}</td><td>${long('Lost cell')}</td></tr>`}
        <tr><td>${long('Kept last')}</td><td>Kept</td></tr></tbody></table>
        ${[1, 2].map((i) => `<p>${long('After ' + i)}</p>`).join('')}</article>`;
      const doc = new DOMParser().parseFromString(`<body>${body(false)}</body>`, 'text/html');
      const content = body(true);
      const checked = coverage(doc, content);
      const article = new DOMParser()
        .parseFromString(`<div>${content}</div>`, 'text/html')
        .body.querySelector('div');
      const done = restore(article, checked.patches);
      const restored = [...article.querySelectorAll('tr')].find((tr) =>
        tr.textContent.includes('Lost row'),
      );
      return {
        passages: done.passages,
        cells: restored ? [...restored.cells].map((cell) => cell.textContent.slice(0, 13)) : [],
      };
    });
    assert.deepEqual(row, { passages: 1, cells: ['Lost row sent', 'Lost cell sen'] });

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

    // YouTube: the worker reads the player data in the page's own world (youtubePlayerData),
    // and the clipping script saves the description and the captions as a transcript.
    const { youtubePlayerData } = await import('../youtube-player.js');
    const video = async (id, mode = 'article') => {
      const url = `https://www.youtube.com/watch?v=${id}`;
      await open(url);
      const player = await page.evaluate(youtubePlayerData, id);
      requests.length = 0;
      return { player, result: await run({ mode, url, player }) };
    };
    const watch = (id, at) => `https://www.youtube.com/watch?v=${id}&t=${at}s`;
    const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The video's own English captions (not the automatic track), from the player's data
    // for this video (the markup's data is an earlier video's).
    const first = await video('FIXTUREvid1');
    assert.equal(first.player.videoId, 'FIXTUREvid1');
    assert.equal(first.player.tracks.length, 3);
    const youtubeClip = first.result;
    assert.equal(youtubeClip.ok, true, JSON.stringify(youtubeClip).slice(0, 300));
    assert.equal(youtubeClip.extractor, 'youtube');
    assert.equal(youtubeClip.coverage, null);
    assert.equal(youtubeClip.title, 'Fixture video 1');
    assert.equal(youtubeClip.byline, 'Fixture Channel');
    assert.equal(youtubeClip.siteName, 'YouTube');
    assert.equal(youtubeClip.publishedAt, '2026-08-14T05:00:01-07:00');
    assert.equal(youtubeClip.cover, 'https://i.ytimg.com/vi/FIXTUREvid1/maxresdefault.jpg');
    assert.deepEqual(youtubeClip.metaSources, {
      author: 'site:www.youtube.com',
      publishedAt: 'site:www.youtube.com',
      siteName: 'site:www.youtube.com',
      cover: 'site:www.youtube.com',
    });
    assert.equal(youtubeClip.contentStatus, 'text');
    assert.equal(youtubeClip.tooLittle, false);
    assert.equal(youtubeClip.language, 'en');
    assert.deepEqual(youtubeClip.transcript, {
      status: 'saved',
      reason: '',
      language: 'en',
      kind: 'manual',
      name: 'English',
      source: 'captions',
    });
    // Only the chosen track's text was requested, from the page's own site.
    assert.deepEqual(
      requests.map((url) => new URL(url).searchParams.get('lang') + new URL(url).pathname),
      ['en/api/timedtext'],
    );
    const ymd = youtubeClip.markdown;
    // The description, with its links and timestamps as links.
    assert.match(ymd, /^## clipVideoDescription\n\nA fixture video about careful reading\./m);
    assert.match(ymd, /\[https:\/\/clip\.test\/notes\]\(https:\/\/clip\.test\/notes\)/);
    assert.match(ymd, new RegExp(`\\[2:30\\]\\(${escaped(watch('FIXTUREvid1', 150))}\\)`));
    // The transcript in chapters, each paragraph starting with a link to its moment.
    assert.match(ymd, /^## clipTranscriptOf\(English\)$/m);
    assert.match(
      ymd,
      new RegExp(
        `^### \\[0:00\\]\\(${escaped(watch('FIXTUREvid1', 0))}\\) Introduction\\n\\n\\[0:00\\]\\(${escaped(watch('FIXTUREvid1', 0))}\\) Sentence 1 about careful reading Sentence 2`,
        'm',
      ),
    );
    assert.match(
      ymd,
      new RegExp(
        `^### \\[1:00\\]\\(${escaped(watch('FIXTUREvid1', 60))}\\) The second part\\n\\n\\[1:00\\]`,
        'm',
      ),
    );
    assert.match(
      ymd,
      new RegExp(`^### \\[2:30\\]\\(${escaped(watch('FIXTUREvid1', 150))}\\) Closing words`, 'm'),
    );
    // A pause of more than three seconds starts a paragraph.
    assert.match(ymd, /Sentence 26 ends a thought\.\n\n\[1:23\]\([^)]+&t=83s\) Sentence 27/);
    assert.match(ymd, /Sentence 60 about careful reading$/);
    // Japanese automatic captions, which YouTube returns only with the player's token: the
    // player's own request is used, and the text is joined without spaces.
    const japaneseVideo = (await video('FIXTUREvid2')).result;
    assert.equal(japaneseVideo.ok, true);
    assert.deepEqual(japaneseVideo.transcript, {
      status: 'saved',
      reason: '',
      language: 'ja',
      kind: 'auto',
      name: '日本語 (自動生成)',
      source: 'player',
    });
    assert.equal(japaneseVideo.language, 'ja');
    assert.match(japaneseVideo.markdown, /^## clipTranscriptOf\(日本語 \(自動生成\)\)$/m);
    assert.match(
      japaneseVideo.markdown,
      /\[0:00\]\([^)]+\) 日本語の字幕1日本語の字幕2日本語の字幕3/,
    );
    // No caption text, but the transcript panel the user opened.
    const fromPanel = (await video('FIXTUREvid3')).result;
    assert.equal(fromPanel.transcript.source, 'panel');
    assert.equal(fromPanel.transcript.status, 'saved');
    assert.match(
      fromPanel.markdown,
      /\[0:00\]\([^)]+&t=0s\) Panel line 1 about reading slowly\. Panel line 2/,
    );
    assert.match(fromPanel.markdown, /Panel line 12 about reading slowly\.$/);
    // YouTube returns no text for the track: only the description, and why.
    const empty = (await video('FIXTUREvid4')).result;
    assert.equal(empty.contentStatus, 'notesOnly');
    assert.deepEqual(empty.transcript, {
      status: 'unavailable',
      reason: 'empty',
      language: '',
      kind: '',
      name: '',
      source: '',
    });
    assert.match(empty.markdown, /Show notes for the episode\./);
    assert.doesNotMatch(empty.markdown, /clipTranscript/);
    // A sign-in or bot check: nothing is tried, and the clip says why.
    const login = (await video('FIXTUREvid5')).result;
    assert.equal(login.contentStatus, 'notesOnly');
    assert.equal(login.transcript.reason, 'login');
    assert.deepEqual(requests, [], 'Nothing is requested past a sign-in check');
    // No captions and no description: only the video's link.
    const bare = (await video('FIXTUREvid6')).result;
    assert.equal(bare.contentStatus, 'linksOnly');
    assert.equal(bare.transcript.reason, 'none');
    // A very long transcript is saved within the Markdown limit, quickly.
    const startedLong = Date.now();
    const longVideo = (await video('FIXTUREvid7')).result;
    assert(Date.now() - startedLong < 30000, `took ${Date.now() - startedLong} ms`);
    assert.equal(longVideo.ok, true);
    assert(Buffer.byteLength(longVideo.markdown) <= 3 * 1024 * 1024);
    assert.match(longVideo.markdown, /Line 1 of a very long talk/);
    // Another video's player data is not used: the page is clipped like any other.
    const other = await video('FIXTUREvid8');
    assert.equal(other.player, null);
    assert.notEqual(other.result.extractor, 'youtube');
    // A selection on a video page is the selection.
    await open('https://www.youtube.com/watch?v=FIXTUREvid1');
    await page.evaluate(() => getSelection().selectAllChildren(document.querySelector('h1')));
    const picked = await run({
      mode: 'selection',
      url: 'https://www.youtube.com/watch?v=FIXTUREvid1',
      player: first.player,
    });
    assert.equal(picked.extractor, 'selection');
    await page.evaluate(() => getSelection().removeAllRanges());

    // Podcast episodes: only show notes is said so; a transcript the page keeps collapsed
    // or on another page of the site is added; an article with an audio version is not one.
    await open('/podcast/notes');
    const notes = await run({ mode: 'article', url: 'https://clip.test/podcast/notes' });
    assert.equal(notes.contentStatus, 'notesOnly');
    assert.equal(notes.transcript.reason, 'none');
    assert.match(notes.markdown, /Show notes paragraph 1/);
    // Video and podcast clips are notes and a transcript: no coverage check.
    assert.equal(notes.coverage, null);
    await open('/podcast/collapsed');
    const collapsed = await run({ mode: 'article', url: 'https://clip.test/podcast/collapsed' });
    assert.equal(collapsed.contentStatus, 'text');
    assert.equal(collapsed.transcript.source, 'page');
    assert.match(
      collapsed.markdown,
      /Show notes paragraph 5[\s\S]*^## clipTranscriptHeading\n\n\*\*Host:\*\* Transcript line 1,[\s\S]*Transcript line 8,/m,
    );
    assert.equal(collapsed.coverage, null);
    assert.deepEqual(requests, []);
    await open('/podcast/dropped');
    const dropped = await run({ mode: 'article', url: 'https://clip.test/podcast/dropped' });
    assert.equal(dropped.contentStatus, 'text');
    assert.equal(dropped.transcript.source, 'page');
    assert.equal(dropped.coverage, null);
    assert.equal(dropped.markdown.match(/Transcript line 1,/g)?.length, 1, dropped.markdown);
    assert.match(
      dropped.markdown,
      /^## clipTranscriptHeading\n\n\*\*Host:\*\* Transcript line 1,/m,
    );
    assert.deepEqual(requests, []);
    await open('/podcast/linked');
    const linked = await run({ mode: 'article', url: 'https://clip.test/podcast/linked' });
    assert.equal(linked.contentStatus, 'text');
    assert.equal(linked.transcript.source, 'link');
    assert.match(linked.markdown, /^## clipTranscriptHeading\n\n[\s\S]*Transcript line 10,/m);
    assert.deepEqual(requests, ['https://clip.test/podcast/linked/transcript']);
    await open('/listen');
    const essay = await run({ mode: 'article', url: 'https://clip.test/listen' });
    assert.equal(essay.contentStatus, 'text');
    assert.equal(essay.transcript, null);
    // Not a podcast: the page's text is checked.
    assert.equal(essay.coverage.restoredPassages, 0);
    // Caption formats: YouTube's XML (srv1, with entities escaped twice) and WebVTT.
    const parsed = await page.evaluate(() => [
      globalThis.tabgentClipMedia.parseCaptions(
        '<?xml version="1.0"?><transcript><text start="1.5" dur="2">It&amp;#39;s here</text><text start="4" dur="1">&amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt;</text></transcript>',
      ),
      globalThis.tabgentClipMedia.parseCaptions(
        'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<c>Hello</c> there\n\n00:01:02.000 --> 00:01:04.000 align:start\nAgain',
      ),
      globalThis.tabgentClipMedia.chapters('0:00 Start\n5:00 Middle\n1:00 Back'),
      globalThis.tabgentClipMedia.chapters('Intro\n0:00 Start\n1:00 Next\n1:02:03 Long'),
    ]);
    assert.deepEqual(parsed[0], [
      { start: 1.5, end: 3.5, text: "It's here" },
      { start: 4, end: 5, text: 'bold' },
    ]);
    assert.deepEqual(parsed[1], [
      { start: 1, end: 3.5, text: 'Hello there' },
      { start: 62, end: 64, text: 'Again' },
    ]);
    assert.deepEqual(parsed[2], [], 'Chapters must increase');
    assert.deepEqual(
      parsed[3].map((chapter) => [chapter.start, chapter.title]),
      [
        [0, 'Start'],
        [60, 'Next'],
        [3723, 'Long'],
      ],
    );

    // The prompt resolves with the chosen action; Escape cancels.
    const choice = page.evaluate(() =>
      globalThis.tabgentClip.ask({ kind: 'replace', clippedAt: '2026-10-12T09:30:00+08:00' }),
    );
    await page.waitForTimeout(50);
    await page.keyboard.press('Escape');
    assert.equal(await choice, 'cancel');
    console.log(
      'PASS clip extraction: article, page, selection, short page, X thread, captions, links only, metadata, cover, YouTube transcripts and podcasts, table shapes, cards, coverage and captured pages',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
