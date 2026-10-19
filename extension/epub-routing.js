// The bundled EPUB reader is an extension page. Each reader document registers an 'epub' port,
// and messages are accepted only from the tab's current reader document, as for PDF.js.
const views = new Map();
const reader = () => chrome.runtime.getURL('epub/reader.html');
export function isEpubReaderUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(reader())) return false;
  const rest = url.slice(reader().length);
  return !rest || rest[0] === '?' || rest[0] === '#';
}
export function isCurrentEpubSender(sender) {
  const port = views.get(sender?.tab?.id);
  return (
    !!port &&
    !sender.tab.incognito &&
    sender.frameId === 0 &&
    isEpubReaderUrl(sender.url) &&
    !!sender.documentId &&
    port.sender.documentId === sender.documentId
  );
}
export function openEpubReader(tab) {
  return chrome.tabs.create({
    url: reader(),
    ...(tab?.windowId != null ? { windowId: tab.windowId } : {}),
    ...(Number.isInteger(tab?.index) ? { index: tab.index + 1 } : {}),
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
  views.set(tab.id, port);
  port.onDisconnect.addListener(() => {
    if (views.get(tab.id) === port) views.delete(tab.id);
  });
  port.postMessage({ type: 'ready' });
  return true;
}
