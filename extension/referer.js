// Image requests with the Referer the browser sends when the page shows them. Some image
// hosts refuse a request without a Referer (anti-hotlinking: sspai.com answers 403), and an
// extension's fetch cannot set one: the header is forbidden and a cross-origin referrer is
// ignored. So each request gets a session rule for its exact address, for the time of that
// request only, and the value follows Chrome's default policy
// (strict-origin-when-cross-origin): the page address for an image of the same origin, only
// the page's origin for another origin, and nothing from an HTTPS page to an HTTP image.
// No cookies are added by this; only the Referer header changes.
const FIRST = 910000,
  COUNT = 1000;
let next = 0;

// The Referer a page's image request carries in Chrome by default, or '' for none.
export function refererFor(pageUrl, target) {
  try {
    const page = new URL(pageUrl),
      image = new URL(target);
    if (!/^https?:$/.test(page.protocol) || !/^https?:$/.test(image.protocol)) return '';
    if (page.protocol === 'https:' && image.protocol === 'http:') return '';
    if (page.origin !== image.origin) return page.origin + '/';
    page.hash = '';
    page.username = page.password = '';
    return page.href;
  } catch {
    return '';
  }
}

// Runs one request for url with the Referer of pageUrl, then removes its rule.
export async function withReferer(url, pageUrl, run) {
  const api = globalThis.chrome?.declarativeNetRequest;
  const value = refererFor(pageUrl, url);
  let target = '';
  try {
    target = new URL(url).href;
  } catch {}
  // URL filters treat * ^ | as patterns; such (rare) addresses go without a Referer.
  if (!value || !target || !api?.updateSessionRules || /[*^|]/.test(target) || target.length > 4096)
    return run();
  const id = FIRST + (next++ % COUNT);
  // A rule that cannot be added (a full rule set, an API error) leaves the request as it
  // was before: without a Referer, never failed for it.
  const added = await Promise.resolve()
    .then(() =>
      api.updateSessionRules({
        removeRuleIds: [id],
        addRules: [
          {
            id,
            priority: 2,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'referer', operation: 'set', value }],
            },
            condition: {
              urlFilter: `|${target}|`,
              initiatorDomains: [chrome.runtime.id],
              tabIds: [chrome.tabs?.TAB_ID_NONE ?? -1],
              resourceTypes: ['xmlhttprequest', 'other'],
            },
          },
        ],
      }),
    )
    .then(
      () => true,
      () => false,
    );
  if (!added) return run();
  try {
    return await run();
  } finally {
    await api.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

// Rules left by a worker that stopped during a request: removed when the worker starts.
export async function clearRefererRules() {
  const api = globalThis.chrome?.declarativeNetRequest;
  if (!api?.getSessionRules || !api.updateSessionRules) return;
  const rules = await api.getSessionRules();
  const stale = rules.map((rule) => rule.id).filter((id) => id >= FIRST && id < FIRST + COUNT);
  if (stale.length) await api.updateSessionRules({ removeRuleIds: stale });
}

// A fetch that sends pageUrl's Referer with each request (for one page's images).
export const refererFetch = (pageUrl, fetchImpl) => (url, options) =>
  withReferer(url, pageUrl, () => fetchImpl(url, options));
