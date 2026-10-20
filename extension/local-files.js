// Files the user opens in Chrome from their computer (file:// URLs). Chrome lets an
// extension read them only after the user turns on "Allow access to file URLs" for it.
// A directory listing (its URL ends in "/") is never a document.
export function isLocalFileUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file:///')) return false;
  try {
    const { protocol, host, pathname } = new URL(url);
    return protocol === 'file:' && !host && pathname.length > 1 && !pathname.endsWith('/');
  } catch {
    return false;
  }
}
// Types Tabgent reads: a first open of one of these explains the file access setting.
export const isReadableFileUrl = (url) =>
  isLocalFileUrl(url) &&
  /\.(?:pdf|md|markdown|mdown|txt|text|html?|xhtml)$/i.test(new URL(url).pathname);
export async function fileAccessAllowed() {
  try {
    return !!(await globalThis.chrome?.extension?.isAllowedFileSchemeAccess?.());
  } catch {
    return false;
  }
}
// Where the user turns the setting on: Tabgent's own page in chrome://extensions.
export const fileAccessSettingsUrl = () => `chrome://extensions/?id=${chrome.runtime.id}`;

// The page that explains the setting, opened once: the first time the user opens a document
// from the computer while Tabgent cannot read it. The side panel keeps a reminder after that.
const prompt = () => chrome.runtime.getURL('file-access.html');
// Content scripts declared in the manifest, for files that were open before Tabgent could
// read them. local-pdf.js hands a PDF in Chrome's viewer to Tabgent's viewer.
const readingLayer = [
  'web-anchor.js',
  'user-error.js',
  'highlight-note.js',
  'highlight-content.js',
];
async function adoptOpenFiles(withText) {
  if (!(await fileAccessAllowed())) return;
  for (const tab of await chrome.tabs.query({ url: 'file:///*' })) {
    if (tab.incognito || !isLocalFileUrl(tab.url)) continue;
    const target = { tabId: tab.id, frameIds: [0] };
    await chrome.scripting.executeScript({ target, files: ['local-pdf.js'] }).catch(() => {});
    if (!withText) continue;
    await chrome.scripting.insertCSS({ target, files: ['highlight.css'] }).catch(() => {});
    for (const files of [['selection-content.js'], readingLayer])
      await chrome.scripting.executeScript({ target, files }).catch(() => {});
  }
}
export function startLocalFiles() {
  let prompting = false;
  chrome.webNavigation?.onCommitted?.addListener(async ({ tabId, frameId, url }) => {
    if (frameId !== 0 || !isReadableFileUrl(url) || prompting) return;
    prompting = true;
    try {
      if (await fileAccessAllowed()) return;
      const { fileAccessPrompted } = await chrome.storage.local.get('fileAccessPrompted');
      if (fileAccessPrompted) return;
      const tab = await chrome.tabs.get(tabId);
      if (tab.incognito) return;
      await chrome.storage.local.set({ fileAccessPrompted: true });
      await chrome.tabs.create({ url: prompt(), windowId: tab.windowId, index: tab.index + 1 });
    } catch (error) {
      console.warn(error);
    } finally {
      prompting = false;
    }
  });
  // Files opened while Chrome was starting load before extension rules apply.
  chrome.runtime.onStartup?.addListener(() => void adoptOpenFiles(false).catch(console.warn));
  // Turning file access on reloads the extension: files already open start working.
  return (async () => {
    const allowed = await fileAccessAllowed();
    const { fileAccess } = await chrome.storage.local.get('fileAccess');
    if (fileAccess === allowed) return;
    await chrome.storage.local.set({ fileAccess: allowed });
    if (allowed && fileAccess === false) await adoptOpenFiles(true);
  })().catch(console.warn);
}
