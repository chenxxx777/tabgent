// Opens an EPUB File with foliate-js and disables the book's scripts before any section renders.
import {
  configure,
  ZipReader,
  BlobReader,
  TextWriter,
  BlobWriter,
} from '../vendor/foliate-js/vendor/zip.js';
import { EPUB } from '../vendor/foliate-js/epub.js';

const MARKUP = new Set(['application/xhtml+xml', 'text/html', 'image/svg+xml']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'data', 'xlink:href']);
const DISABLED = 'application/x-tabgent-disabled';

export async function openBook(file) {
  configure({ useWebWorkers: false });
  const zip = new ZipReader(new BlobReader(file));
  const entries = await zip.getEntries();
  const map = new Map(entries.map((entry) => [entry.filename, entry]));
  const book = await new EPUB({
    entries,
    loadText: (name) => map.get(name)?.getData(new TextWriter()) ?? null,
    loadBlob: (name, type) => map.get(name)?.getData(new BlobWriter(type)) ?? null,
    getSize: (name) => map.get(name)?.uncompressedSize ?? 0,
  }).init();
  if (!book.sections?.length) throw Error('The book has no readable sections');
  disableScripts(book);
  return book;
}

// Layers: script resources are never loaded, markup is neutralized here, the reader's CSP and
// the extension CSP block script execution, and foliate's iframes allow no forms or popups.
export function disableScripts(book) {
  const target = book.transformTarget;
  target.addEventListener('load', (event) => {
    if (event.detail.isScript) event.detail.allow = false;
  });
  target.addEventListener('data', (event) => {
    const { type } = event.detail;
    if (!MARKUP.has(type)) return;
    event.detail.data = Promise.resolve(event.detail.data).then((data) =>
      typeof data === 'string' ? neutralize(data, type) : data,
    );
  });
}

// Scripts keep their element (with an inert type) so that CFIs computed here match the book.
export function neutralize(markup, type) {
  let doc = new DOMParser().parseFromString(markup, type);
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(markup, 'text/html');
  for (const script of doc.querySelectorAll('script')) {
    script.setAttribute('type', DISABLED);
    script.removeAttribute('src');
    script.textContent = '';
  }
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.replace(/[\u0000- ]/g, '');
      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        (URL_ATTRIBUTES.has(name) && /^(?:javascript|vbscript):/i.test(value))
      )
        element.removeAttributeNode(attribute);
    }
  }
  // Only head elements are removed, so body CFIs are unchanged.
  for (const meta of doc.querySelectorAll('head meta[http-equiv]')) meta.remove();
  return new XMLSerializer().serializeToString(doc);
}

// Metadata values may be strings, language maps or contributor objects.
export function label(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(label).filter(Boolean).join(', ');
  if (value.name) return label(value.name);
  return label(Object.values(value)[0]);
}
