// The Referer of a page's image requests: Chrome's default policy values, and one session
// rule per request for its exact address, removed afterwards (also when it fails).
import assert from 'node:assert/strict';

const calls = [];
globalThis.chrome = {
  runtime: { id: 'tabgentid' },
  tabs: { TAB_ID_NONE: -1 },
  declarativeNetRequest: {
    updateSessionRules: async (change) => void calls.push(change),
  },
};
const { refererFor, withReferer, refererFetch } = await import('../referer.js');

// Same origin: the page address without its fragment; another origin: only the origin;
// HTTPS page to HTTP image: none; non-web addresses: none.
const page = 'https://sspai.com/post/116661?from=rss#top';
assert.equal(
  refererFor(page, 'https://sspai.com/img/a.png'),
  'https://sspai.com/post/116661?from=rss',
);
assert.equal(refererFor(page, 'https://cdnfile.sspai.com/a.png'), 'https://sspai.com/');
assert.equal(refererFor(page, 'http://cdn.example/a.png'), '');
assert.equal(
  refererFor('http://site.example/p', 'http://cdn.example/a.png'),
  'http://site.example/',
);
assert.equal(
  refererFor('https://user:secret@site.example/p', 'https://site.example/a.png'),
  'https://site.example/p',
);
assert.equal(refererFor('', 'https://cdn.example/a.png'), '');
assert.equal(refererFor('urn:tabgent:feed:' + '0'.repeat(64), 'https://cdn.example/a.png'), '');

// One rule for the exact address while the request runs, then removed.
const image = 'https://cdnfile.sspai.com/2026/10/19/article/a.png?imageView2/2/w/1120';
const result = await withReferer(image, page, async () => {
  assert.equal(calls.length, 1, 'The rule is in place during the request');
  return 'response';
});
assert.equal(result, 'response');
const [added, removed] = calls;
const rule = added.addRules[0];
assert.deepEqual(added.removeRuleIds, [rule.id]);
assert(rule.id >= 910000 && rule.id < 911000);
assert.deepEqual(rule.action, {
  type: 'modifyHeaders',
  requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://sspai.com/' }],
});
assert.deepEqual(rule.condition, {
  urlFilter: `|${image}|`,
  initiatorDomains: ['tabgentid'],
  tabIds: [-1],
  resourceTypes: ['xmlhttprequest', 'other'],
});
assert.deepEqual(removed, { removeRuleIds: [rule.id] });

// A failed request still removes its rule; concurrent requests get their own rules.
calls.length = 0;
await assert.rejects(
  withReferer(image, page, async () => {
    throw Error('network');
  }),
  /network/,
);
assert.deepEqual(calls.at(-1), { removeRuleIds: [calls[0].addRules[0].id] });
calls.length = 0;
const seen = [];
const fetchImpl = async (url) => (seen.push(url), url);
await Promise.all(
  ['https://cdn.example/1.png', 'https://cdn.example/2.png'].map((url) =>
    refererFetch(page, fetchImpl)(url, {}),
  ),
);
const ids = calls.filter((change) => change.addRules).map((change) => change.addRules[0].id);
assert.equal(new Set(ids).size, 2);
assert.deepEqual(seen.sort(), ['https://cdn.example/1.png', 'https://cdn.example/2.png']);

// No rule when there is no Referer to send, or the address would be a pattern.
calls.length = 0;
assert.equal(await withReferer('http://cdn.example/a.png', page, async () => 'plain'), 'plain');
assert.equal(await withReferer('https://cdn.example/a*b.png', page, async () => 'plain'), 'plain');
assert.equal(calls.length, 0);
console.log('PASS image requests carry the Referer Chrome sends, one rule per request');
