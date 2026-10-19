// The bundled EPUB reader is an extension page. Each reader document registers an 'epub' port,
// and messages are accepted only from the tab's current reader document, as for PDF.js.
// The port also names the open book and carries the worker's commands to the reader.
import { bookUrl } from './vault-client.js';
const views = new Map();
let sequence = 0;
const reader = () => chrome.runtime.getURL('epub/reader.html');
export function isEpubReaderUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(reader())) return false;
  const rest = url.slice(reader().length);
  return !rest || rest[0] === '?' || rest[0] === '#';
}
export function isCurrentEpubSender(sender) {
  const view = views.get(sender?.tab?.id);
  return (
    !!view &&
    !sender.tab.incognito &&
    sender.frameId === 0 &&
    isEpubReaderUrl(sender.url) &&
    !!sender.documentId &&
    view.port.sender.documentId === sender.documentId
  );
}
// The vault document of a reader tab: undefined for other tabs, null while no book is open.
export function epubDocument(tab) {
  if (!isEpubReaderUrl(tab?.url)) return undefined;
  const book = views.get(tab.id)?.book;
  return book ? { url: book.url, title: book.title, kind: 'epub' } : null;
}
export function openEpubReader(tab) {
  return chrome.tabs.create({
    url: reader(),
    ...(tab?.windowId != null ? { windowId: tab.windowId } : {}),
    ...(Number.isInteger(tab?.index) ? { index: tab.index + 1 } : {}),
  });
}
// Highlight commands for a reader tab, the same messages the webpage content script answers.
export function epubCommand(tabId, command, timeout = 5000) {
  const view = views.get(tabId);
  if (!view) return Promise.reject(Error('The EPUB reader is not connected'));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      view.pending.delete(id);
      reject(Error('The EPUB reader did not answer'));
    }, timeout);
    view.pending.set(id, { resolve, reject, timer });
    view.port.postMessage({ type: 'command', id, command });
  });
}
// Called from the worker's port listener; returns false for ports that are not a reader.
export function registerEpubPort(port) {
  const tab = port.sender?.tab;
  if (
    !tab ||
    tab.incognito ||
    port.sender.frameId !== 0 ||
    !port.sender.documentId ||
    !isEpubReaderUrl(port.sender.url)
  ) {
    port.disconnect();
    return false;
  }
  const view = { port, book: null, pending: new Map() };
  views.set(tab.id, view);
  port.onMessage.addListener((message) => {
    if (message?.type === 'book') {
      const url = bookUrl(message.sha256);
      const title = typeof message.title === 'string' ? message.title.slice(0, 500) : '';
      view.book = url ? { url, title } : null;
    } else if (message?.type === 'reply') {
      const pending = view.pending.get(message.id);
      if (!pending) return;
      view.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Error(String(message.error)));
      else pending.resolve(message.result ?? null);
    }
  });
  port.onDisconnect.addListener(() => {
    if (views.get(tab.id) === view) views.delete(tab.id);
    for (const pending of view.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error('The EPUB reader closed'));
    }
  });
  port.postMessage({ type: 'ready' });
  return true;
}
