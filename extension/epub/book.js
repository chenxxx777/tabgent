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
  // Chromium's automatic JS optimizer policy can isolate extension blob navigations
  // in a separate renderer. srcdoc inherits the reader's context, so foliate can
  // measure the chapter and attach selections/overlays without browser flags.
  for (const section of book.sections) {
    const load = section.load;
    section.load = async () => {
      const url = await load();
      if (!url) throw Error('The chapter has no readable content');
      const response = await fetch(url);
      if (!response.ok) throw Error('The chapter could not be read');
      const type = response.headers.get('content-type')?.split(';')[0];
      if (type?.startsWith('image/') && type !== 'image/svg+xml')
        return { srcdoc: `<!doctype html><html><body><img src="${url}"></body></html>` };
      return { srcdoc: chapterHtml(await response.text(), type) };
    };
  }
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
  return type === 'text/html'
    ? doc.documentElement.outerHTML
    : new XMLSerializer().serializeToString(doc);
}

// Metadata values may be strings, language maps or contributor objects.
export function label(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(label).filter(Boolean).join(', ');
  if (value.name) return label(value.name);
  return label(Object.values(value)[0]);
}

// srcdoc is HTML. Serialize an HTML-owned tree so empty XHTML elements such as
// <script/> and <div/> receive end tags instead of swallowing the following text.
function chapterHtml(markup, type) {
  const parsed = new DOMParser().parseFromString(markup, MARKUP.has(type) ? type : 'text/html');
  if (parsed.querySelector('parsererror')) throw Error('The chapter contains invalid markup');
  const html = document.implementation.createHTMLDocument();
  if (parsed.documentElement.localName === 'svg') {
    const svg = html.importNode(parsed.documentElement, true);
    const [, , width, height] = svg.getAttribute('viewBox')?.split(/[\s,]+/) || [];
    const viewport = html.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = `width=${width || 1000},height=${height || 1000}`;
    html.head.append(viewport);
    html.body.style.margin = '0';
    html.body.append(svg);
  } else html.replaceChild(html.importNode(parsed.documentElement, true), html.documentElement);
  // HTML raw-text parsing can expose markup that was text in the XHTML tree.
  // Sanitize the final HTML tree as well, then use its HTML serializer.
  return '<!doctype html>\n' + neutralize(html.documentElement.outerHTML, 'text/html');
}
