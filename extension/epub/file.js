// An EPUB book opened from the computer (file://). Chrome lets this page read the file while
// the user allows Tabgent access to file URLs. The book is copied into the reading vault as
// the library's import copies it, then opens in the reader from that copy. The vault names a
// book by the SHA-256 of its bytes: opening the same book again opens the copy it already
// has, with its highlights, notes, reading position and conversation.
import { localize, t, loadTimeData } from '../i18n.js';
import '../user-error.js';
import { epubFileSource } from '../epub-routing.js';
import { fileAccessAllowed, fileAccessSettingsUrl } from '../local-files.js';
import { openBook, bookDetails } from './book.js';
import { ask, importBook, sha256Hex } from './library.js';

const $ = (selector) => document.querySelector(selector);
const LIMIT = 100 * 1024 * 1024; // The vault's limit for imported originals.
const percent = (fraction) => `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
const shown = (error) =>
  globalThis.tabgentExplainError?.(error, (key, ...args) =>
    args.length ? loadTimeData.getStringF(key, ...args) : t(key),
  ) || t('errorGeneric');
localize();
const status = (text) => ($('#status').textContent = text);
function fail(text, settings = false) {
  $('#status').hidden = true;
  $('#message').textContent = text;
  $('#settings').hidden = !settings;
  $('#problem').hidden = false;
}
$('#library').onclick = () => location.assign(chrome.runtime.getURL('epub/reader.html'));
$('#settings').onclick = async () => {
  const tab = await chrome.tabs.getCurrent();
  await chrome.tabs.update(tab.id, { url: fileAccessSettingsUrl() });
};

// The file's bytes, or null when it is larger than the vault keeps.
async function read(url) {
  const response = await fetch(url.split('#')[0]);
  if (!response.ok) throw Error(`The file could not be read (${response.status})`);
  const reader = response.body.getReader(),
    parts = [];
  for (let size = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMIT) {
      void reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

function fileName(url) {
  const last = new URL(url).pathname.split('/').pop();
  try {
    return decodeURIComponent(last) || 'book.epub';
  } catch {
    return last || 'book.epub';
  }
}

async function openFromFile() {
  // The page reads its file only as the tab's page: a local HTML page cannot embed it.
  const source = window.top === window ? epubFileSource(location.href) : null;
  if (!source) return fail(t('epubFileInvalid'));
  const name = fileName(source);
  $('#name').textContent = document.title = name;
  let bytes;
  try {
    bytes = await read(source);
  } catch {
    // Without file access Chrome does not apply the redirect, but the page can still be
    // opened directly: it says what to turn on.
    const allowed = await fileAccessAllowed();
    return fail(t(allowed ? 'epubFileUnreadable' : 'epubFileNoAccess'), !allowed);
  }
  if (!bytes) return fail(t('libraryTooLarge'));
  // An EPUB is a ZIP archive whose package names its chapters; anything else is refused
  // before it reaches the vault.
  let details;
  try {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw Error('Not a ZIP archive');
    const book = await openBook(new File([bytes], name, { type: 'application/epub+zip' }));
    details = bookDetails(book, name);
    book.destroy?.();
  } catch {
    return fail(t('epubFileNotEpub'));
  }
  let result;
  try {
    const sha256 = await sha256Hex(bytes);
    status(loadTimeData.getStringF('epubSaving', '0%'));
    result = await importBook({
      bytes,
      sha256,
      ...details,
      name,
      request: ask,
      onProgress: (fraction) => status(loadTimeData.getStringF('epubSaving', percent(fraction))),
    });
    if (!result.document?.id) throw Error('The vault returned no document');
  } catch (error) {
    return fail(loadTimeData.getStringF('epubFileSaveFailed', shown(error)));
  }
  // The reader opens the vault copy, as from the library; this page leaves no history entry.
  location.replace(
    chrome.runtime.getURL('epub/reader.html') + '?book=' + encodeURIComponent(result.document.id),
  );
}
void openFromFile().catch((error) => fail(loadTimeData.getStringF('epubOpenFailed', shown(error))));
