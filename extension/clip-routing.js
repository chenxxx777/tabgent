// Tabgent's reader of clipped pages is an extension page, clip/reader.html?url=<page URL>.
// Its address names the page (the vault document), as the PDF viewer's names its PDF. Each
// reader document registers a 'clip' port, and messages are accepted only from the tab's
// current reader document; Chrome hides extension documents from webNavigation.getFrame.
const reader = () => chrome.runtime.getURL('clip/reader.html') + '?url=';
const views = new Map();

// The page a reader address names (HTTP(S), without fragment), or null. A feed item
// without a link is named urn:tabgent:feed:<64 hex>.
export function clipSource(url = '') {
  if (typeof url !== 'string' || !url.startsWith(reader())) return null;
  const urn = /^urn:tabgent:feed:[0-9a-f]{64}(?=#|$)/.exec(url.slice(reader().length));
  if (urn) return urn[0];
  try {
    const page = new URL(url.slice(reader().length));
    if (!/^https?:$/.test(page.protocol)) return null;
    page.hash = '';
    return page.href;
  } catch {
    return null;
  }
}
export const clipViewerUrl = (url) => reader() + url.split('#')[0];
// A reader tab as browser context: the clipped page's address, marked as the clipped copy.
export function clipTab(tab) {
  const url = clipSource(tab?.url);
  return url ? { ...tab, url, viewer: 'clip' } : tab;
}

export async function isCurrentClipSender(sender) {
  const view = views.get(sender?.tab?.id);
  return (
    !!view &&
    !sender.tab.incognito &&
    sender.frameId === 0 &&
    !!clipSource(sender.url) &&
    !!sender.documentId &&
    view.port.sender.documentId === sender.documentId &&
    (await chrome.tabs.get(sender.tab.id).catch(() => null))?.url === sender.url
  );
}

// Called from the worker's port listener for 'clip' ports.
export function registerClipPort(port) {
  const tab = port.sender?.tab;
  if (
    !tab ||
    tab.incognito ||
    port.sender.frameId !== 0 ||
    !port.sender.documentId ||
    !clipSource(port.sender.url)
  ) {
    port.disconnect();
    return false;
  }
  const view = { port, pending: new Map() };
  views.set(tab.id, view);
  port.onMessage.addListener((message) => {
    const entry = message?.type === 'reply' && view.pending.get(message.id);
    if (!entry) return;
    view.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(Error(String(message.error)));
    else entry.resolve(message.result ?? null);
  });
  port.onDisconnect.addListener(() => {
    if (views.get(tab.id) === view) views.delete(tab.id);
    for (const entry of view.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error('The reader closed'));
    }
    view.pending.clear();
  });
  port.postMessage({ type: 'ready' });
  return true;
}

// Asks a tab's current reader for something only it has (a feed item's cleaned text).
let commands = 0;
export function clipCommand(tabId, command, timeout = 30000) {
  const view = views.get(tabId);
  if (!view) return Promise.reject(Error('The reader is not open'));
  const id = ++commands;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      view.pending.delete(id);
      reject(Error('The reader did not answer'));
    }, timeout);
    view.pending.set(id, { resolve, reject, timer });
    view.port.postMessage({ type: 'command', id, command });
  });
}
