// PDF.js is optional: a failed viewer returns to the native PDF in the same tab.
const viewer = () => chrome.runtime.getURL('pdf/viewer.html') + '?url=';
const views = new Map();
let sequence = 0;
// A PDF imported from the computer is named by the SHA-256 of its bytes, like an EPUB book.
// Its viewer loads the copy in the ReadingVault; there is no web URL to fall back to.
const LOCAL = /^urn:sha256:[0-9a-f]{64}(?:#.*)?$/s;
export function pdfSource(url = '') {
  if (!url.startsWith(viewer())) return null;
  const rest = url.slice(viewer().length);
  if (LOCAL.test(rest)) return rest;
  try {
    const source = new URL(rest);
    return /^https?:$/.test(source.protocol) ? source.href : null;
  } catch {
    return null;
  }
}
export const isLocalPdf = (source) => LOCAL.test(source || '');
// The viewer URL for an online PDF or an imported one (urn:sha256:...).
export const pdfViewerUrl = (source) => viewer() + source;
export function pdfTab(tab) {
  const url = pdfSource(tab.url);
  return url ? { ...tab, url, contentType: 'application/pdf', viewer: 'pdfjs' } : tab;
}
export async function isCurrentPdfSender(sender) {
  const view = views.get(sender.tab?.id);
  return (
    !!view &&
    sender.frameId === 0 &&
    !!sender.documentId &&
    view.port.sender.documentId === sender.documentId &&
    (await chrome.tabs.get(sender.tab.id)).url === sender.url
  );
}
export function pdfCommand(tabId, args) {
  const view = views.get(tabId);
  if (!view) return Promise.reject(Error('PDF viewer is loading; retry shortly'));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      view.pending.delete(id);
      reject(Error('PDF operation timed out'));
    }, 30000);
    view.pending.set(id, { resolve, reject, timer });
    view.port.postMessage({ id, args });
  });
}
export function startPdfRouting() {
  const api = chrome.declarativeNetRequest;
  if (!api) return; // Test harnesses and unsupported installations keep native behavior.
  api
    .updateDynamicRules({
      removeRuleIds: [900001],
      addRules: [
        {
          id: 900001,
          priority: 1,
          action: { type: 'redirect', redirect: { regexSubstitution: viewer() + '\\0' } },
          condition: {
            regexFilter: '^https?://.*',
            resourceTypes: ['main_frame'],
            excludedRequestMethods: ['post'],
            excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
            responseHeaders: [
              { header: 'content-type', values: ['application/pdf', 'application/pdf;*'] },
            ],
          },
        },
      ],
    })
    .catch(console.warn);
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'pdf') return;
    const tab = port.sender?.tab;
    if (!tab || tab.incognito || port.sender.frameId !== 0 || !pdfSource(port.sender.url)) return;
    const view = { port, pending: new Map() };
    views.set(tab.id, view);
    port.onMessage.addListener((message) => {
      const p = view.pending.get(message.id);
      if (!p) return;
      view.pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) p.reject(Error(message.error));
      else p.resolve(message.result);
    });
    port.onDisconnect.addListener(() => {
      if (views.get(tab.id) === view) views.delete(tab.id);
      for (const p of view.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error('PDF viewer closed'));
      }
    });
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type !== 'pdfFallback') return;
    const source = pdfSource(sender.url),
      tab = sender.tab;
    if (!source || !tab || tab.incognito || sender.frameId !== 0) return;
    if (isLocalPdf(source)) return void reply({ error: 'An imported PDF has no web address' });
    // Session rules are tab-scoped: other tabs still use PDF.js, including the same PDF.
    (async () => {
      const id = 1000000 + tab.id;
      await api.updateSessionRules({
        removeRuleIds: [id],
        addRules: [
          {
            id,
            priority: 100,
            action: { type: 'allow' },
            condition: {
              tabIds: [tab.id],
              resourceTypes: ['main_frame'],
              urlFilter: '|' + source.split('#')[0] + '|',
            },
          },
        ],
      });
      await chrome.tabs.update(tab.id, { url: source });
    })().then(
      () => reply({}),
      (e) => reply({ error: e.message }),
    );
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    api.updateSessionRules({ removeRuleIds: [1000000 + tabId] }).catch(() => {});
  });
}
