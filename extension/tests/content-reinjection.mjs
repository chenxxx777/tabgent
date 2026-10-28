import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reinjectContentScripts } from '../content-reinjection.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
const frames = [
  { frameId: 0, documentId: 'main', url: 'https://reader.test/article' },
  { frameId: 1, documentId: 'child', url: 'http://other.test/frame' },
  { frameId: 2, documentId: 'blank', url: 'about:blank' },
  { frameId: 3, documentId: 'cached', url: 'https://reader.test/old', documentLifecycle: 'cached' },
];
const calls = [];
let fileAccess = false;
const api = {
  runtime: { getManifest: () => manifest },
  extension: { isAllowedFileSchemeAccess: async () => fileAccess },
  tabs: { query: async () => [1, 2, 3, 4, 5].map((id) => ({ id })) },
  webNavigation: {
    getAllFrames: async ({ tabId }) => {
      if (tabId === 1) return frames;
      if (tabId === 2) return [{ frameId: 0, documentId: 'file', url: 'file:///tmp/article.html' }];
      if (tabId === 3) return [{ frameId: 0, url: 'file:///tmp/' }];
      if (tabId === 4) return [{ frameId: 0, url: 'chrome://extensions/' }];
      throw Error('Tab closed during enumeration');
    },
  },
  scripting: Object.fromEntries(
    ['executeScript', 'removeCSS', 'insertCSS'].map((method) => [
      method,
      async (options) => calls.push({ method, ...options }),
    ]),
  ),
};
await reinjectContentScripts(api);
let injected = calls.filter((call) => call.method === 'executeScript');
const main = injected.find((call) => call.target.documentIds[0] === 'main');
const child = injected.find((call) => call.target.documentIds[0] === 'child');
assert.equal(injected.length, 2);
assert.deepEqual(main.target, { tabId: 1, documentIds: ['main'] });
assert.deepEqual(main.files, [
  'content-lifecycle.js',
  'selection-content.js',
  'web-anchor.js',
  'user-error.js',
  'highlight-note.js',
  'hover-translate.js',
  'highlight-content.js',
]);
assert.deepEqual(child.files, ['content-lifecycle.js', 'selection-content.js']);
assert.equal(calls.filter((call) => call.method === 'insertCSS').length, 1);

calls.length = 0;
fileAccess = true;
await reinjectContentScripts(api);
injected = calls.filter((call) => call.method === 'executeScript');
assert.equal(
  injected.length,
  3,
  'File access includes files, excludes directories and restricted URLs',
);
assert(
  injected.find((call) => call.target.documentIds?.[0] === 'file').files.includes('local-pdf.js'),
);

api.scripting.executeScript = async () => {
  throw Error('Cannot access this restricted page');
};
await reinjectContentScripts(api);
console.log(
  'PASS manifest order, frame scope, file permission, exclusions and inaccessible-tab isolation',
);
