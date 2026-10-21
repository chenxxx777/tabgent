import { isLocalFileUrl } from './local-files.js';
// PDF.js is optional: a failed viewer returns to the native PDF in the same tab.
const viewer = () => chrome.runtime.getURL('pdf/viewer.html') + '?url=';
// A PDF opened from the computer (file://) has its own entry page. It is web accessible only
// to file:// pages, so a website cannot open it to show or read a file from the computer.
const fileViewer = () => chrome.runtime.getURL('pdf/file.html') + '?url=';
const views = new Map();
let sequence = 0;
// A PDF imported from the computer is named by the SHA-256 of its bytes, like an EPUB book.
// Its viewer loads the copy in the reading vault; there is no web URL to fall back to.
const LOCAL = /^urn:sha256:[0-9a-f]{64}(?:#.*)?$/s;
const SHA256 = /^[0-9a-f]{64}$/;
export function pdfSource(url = '') {
  if (typeof url !== 'string') return null;
  if (url.startsWith(fileViewer())) {
    const rest = url.slice(fileViewer().length);
    return isLocalFileUrl(rest) ? new URL(rest).href : null;
  }
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
// A PDF the user opened from the computer in Chrome (file://), shown by file.html.
export const isFilePdf = (source) => isLocalFileUrl(source);
// The viewer URL for an online PDF, an imported one (urn:sha256:...) or a file:// one.
export const pdfViewerUrl = (source) => (isFilePdf(source) ? fileViewer() : viewer()) + source;
// A PDF opened from the computer is named in the vault by the SHA-256 of its bytes, like an
// imported one, so both share their notes and the notes survive moving the file. Its viewer
// announces the hash on its port once the file is read: undefined for other tabs, null until
// then.
export function filePdfDocument(tab) {
  const source = pdfSource(tab?.url);
  if (!isFilePdf(source)) return undefined;
  const sha256 = views.get(tab.id)?.sha256;
  return sha256 ? { url: 'urn:sha256:' + sha256, kind: 'pdf' } : null;
}
// The vault URL of a file:// PDF viewer's document, waiting briefly for its hash.
export async function filePdfUrl(tabId, wait = 5000) {
  for (const end = Date.now() + wait; ; await new Promise((r) => setTimeout(r, 50))) {
    const sha256 = views.get(tabId)?.sha256;
    if (sha256) return 'urn:sha256:' + sha256;
    if (Date.now() >= end) throw Error('Stale PDF viewer');
  }
}
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
// Whether the user chose Chrome's viewer for this PDF in this tab (Open in Chrome viewer).
async function nativeChosen(tabId, url) {
  const rules = (await chrome.declarativeNetRequest?.getSessionRules?.()) || [];
  return rules.some(
    (rule) =>
      rule.id === 1000000 + tabId && rule.condition?.urlFilter === '|' + url.split('#')[0] + '|',
  );
}
export function startPdfRouting() {
  const api = chrome.declarativeNetRequest;
  if (!api) return; // Test harnesses and unsupported installations keep native behavior.
  api
    .updateDynamicRules({
      removeRuleIds: [900001, 900002],
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
        // A file:// navigation has no response headers: a .pdf path (any case) opens in the
        // viewer before Chrome's own viewer loads. Chrome applies the rule only while the user
        // allows Tabgent access to file URLs. Directories end in "/" and never match.
        {
          id: 900002,
          priority: 1,
          action: { type: 'redirect', redirect: { regexSubstitution: fileViewer() + '\\0' } },
          condition: {
            regexFilter: '^file:///[^?#]*\\.pdf(?:[?#].*)?$',
            resourceTypes: ['main_frame'],
          },
        },
      ],
    })
    .catch(console.warn);
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'pdf') return;
    const tab = port.sender?.tab;
    if (!tab || tab.incognito || port.sender.frameId !== 0 || !pdfSource(port.sender.url)) return;
    const view = { port, pending: new Map(), sha256: null };
    views.set(tab.id, view);
    port.onMessage.addListener((message) => {
      // A file:// PDF's viewer names the file it read; nothing else can set its identity.
      if (message?.type === 'document') {
        if (isFilePdf(pdfSource(port.sender.url)) && SHA256.test(message.sha256 || ''))
          view.sha256 = message.sha256;
        return;
      }
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
    if (message.type === 'localPdfOpen') {
      // From local-pdf.js in Chrome's own viewer for a file:// PDF (top frame only).
      const tab = sender.tab;
      if (!tab || tab.incognito || sender.frameId !== 0 || !isLocalFileUrl(sender.url)) return;
      nativeChosen(tab.id, sender.url).then(
        (native) => reply(native ? {} : { url: fileViewer() + sender.url }),
        () => reply({}),
      );
      return true;
    }
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
