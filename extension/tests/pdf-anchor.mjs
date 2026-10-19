// PDF anchors without a browser: page text, quotes, restore decisions and rect merging.
import assert from 'node:assert/strict';
import * as anchors from '../pdf/pdf-anchor.js';
import { cleanPdfAnchor } from '../vault-client.js';

const items = (...lines) =>
  lines.flatMap((line) => [
    { type: 'beginMarkedContent', tag: 'P' },
    { str: line, hasEOL: true },
    { type: 'endMarkedContent' },
  ]);
assert.equal(
  anchors.pageText([
    { str: '  Intrinsic ', hasEOL: false },
    { str: 'moti­vation', hasEOL: true },
    { str: '', hasEOL: true },
    { type: 'beginMarkedContentProps', id: 'x' },
    { str: 'is​ self-', hasEOL: true },
    { str: 'endorsed.   ', hasEOL: false },
  ]),
  'Intrinsic motivation is self- endorsed.',
);
assert.equal(anchors.pageText([]), '');
console.log('PASS page text: whitespace runs and line ends become one space, like the text layer');

const page1 = 'Chapter one. Reading slowly helps. Autonomy is endorsement of one’s own actions.';
const page2 = 'Notes continue here. A shared phrase appears. The end of page two';
const single = anchors.describe([page1], 4, page1.indexOf('Autonomy'), page1.indexOf(' of one'));
assert.deepEqual(single.anchor, {
  kind: 'pdf',
  page: 4,
  quote: {
    exact: 'Autonomy is endorsement',
    prefix: 'pter one. Reading slowly helps. ',
    suffix: ' of one’s own actions.',
  },
  textLayer: { start: 35, end: 58 },
});
assert.deepEqual(single.segments, [{ page: 4, start: 35, end: 58 }]);
const across = anchors.describe(
  [page1, page2],
  4,
  page1.indexOf('own'),
  page2.indexOf(' A shared'),
);
assert.equal(across.anchor.page, 4);
assert.equal(across.anchor.endPage, 5);
assert.equal(across.anchor.quote.exact, 'own actions. Notes continue here.');
assert.equal(across.anchor.quote.suffix, ' A shared phrase appears. The en');
assert.deepEqual(across.segments, [
  { page: 4, start: page1.indexOf('own'), end: page1.length },
  { page: 5, start: 0, end: page2.indexOf(' A shared') },
]);
// A selection that starts in trailing whitespace belongs to the next page only.
const shifted = anchors.describe([page1 + ' ', page2], 4, page1.length, 5);
assert.equal(shifted.anchor.page, 5);
assert.equal(shifted.anchor.endPage, undefined);
assert.deepEqual(shifted.anchor.textLayer, { start: 0, end: 5 });
assert.equal(anchors.describe([page1], 1, 10, 10), null);
console.log('PASS describe: page, quote with page-local context, offsets, cross-page endPage');

// A fake document: page → text, counting lazy loads.
function pdf(texts) {
  const loads = [];
  return {
    loads,
    count: texts.length,
    text: async (page) => (loads.push(page), texts[page - 1]),
  };
}
const filler = (n) => `Filler paragraph number ${n} keeps pages apart.`;
const quoted = 'endorsement of one’s own actions';
const original = [filler(1), `Autonomy is ${quoted}, not independence.`, filler(3)];
const anchor = anchors.describe(
  [original[1]],
  2,
  original[1].indexOf(quoted),
  original[1].indexOf(quoted) + quoted.length,
).anchor;

let doc = pdf(original);
let match = await anchors.resolve(anchor, doc);
assert.equal(match.method, 'position');
assert.deepEqual(match.segments, [{ page: 2, start: 12, end: 12 + quoted.length }]);
assert.deepEqual(doc.loads, [2], 'A verified page never loads other pages');

doc = pdf([filler(1), `New preface. Autonomy is ${quoted}, not independence.`, filler(3)]);
match = await anchors.resolve(anchor, doc);
assert.equal(match.method, 'quote');
assert.deepEqual(match.segments, [{ page: 2, start: 25, end: 25 + quoted.length }]);
assert.deepEqual(doc.loads, [2]);
console.log('PASS restore: saved offsets verify; text moved on the same page is found by quote');

// A revised PDF at the same URL: one inserted page moves the passage to page 3.
doc = pdf([filler(1), filler('inserted'), original[1], filler(3)]);
match = await anchors.resolve(anchor, doc);
assert.equal(match.method, 'document-quote');
assert.deepEqual(match.segments, [{ page: 3, start: 12, end: 12 + quoted.length }]);
// The document shrank below the saved page.
match = await anchors.resolve({ ...anchor, page: 9 }, pdf([original[1]]));
assert.deepEqual(match.segments, [{ page: 1, start: 12, end: 12 + quoted.length }]);
console.log('PASS restore: text moved to another page is found by a whole-document search');

// The passage is gone from its page and repeated, with identical context, on two others.
const twin = `Autonomy is ${quoted}, not independence.`;
assert.equal(
  await anchors.resolve(anchor, pdf([twin, filler(2), filler(3), filler(4), filler(5), twin])),
  null,
);
// Equidistant twins on the saved page are ambiguous; a clearly closer one wins.
const short = { ...anchor, quote: { ...anchor.quote, prefix: '', suffix: '' } };
assert.equal(
  await anchors.resolve(
    { ...short, textLayer: { start: 200, end: 230 } },
    pdf([filler(1), `${twin} ${twin}`]),
  ),
  null,
);
match = await anchors.resolve(
  { ...short, page: 2, textLayer: { start: 13, end: 13 + quoted.length } },
  pdf([filler(1), `${twin} ${filler(9)} ${filler(10)} ${filler(11)} ${twin}`]),
);
assert.equal(match.method, 'position-tiebreak');
assert.equal(match.segments[0].start, 12);
// A short quote with unrelated context is not trusted anywhere.
assert.equal(
  await anchors.resolve(
    { kind: 'pdf', page: 1, quote: { exact: 'the', prefix: 'zzzz ', suffix: ' qqqq' } },
    pdf(['See the note.', 'And the rest.']),
  ),
  null,
);
console.log('PASS restore: ambiguous quotes stay unanchored; only a clearly closer twin decides');

doc = pdf([filler(1), `Autonomy is endorsement of one’s own action, not independence.`]);
match = await anchors.resolve(anchor, doc);
assert.equal(match.method, 'fuzzy');
assert.equal(
  doc.count && (await doc.text(2)).slice(match.segments[0].start, match.segments[0].end),
  'endorsement of one’s own action',
);
assert.equal(await anchors.resolve(anchor, pdf([filler(1), filler(2), filler(3)])), null);
for (const bad of [null, { kind: 'web', page: 1, quote: anchor.quote }, { kind: 'pdf', quote: {} }])
  assert.equal(await anchors.resolve(bad, pdf(original)), null);
console.log('PASS restore: a lightly edited quote matches between its old context; gone = null');

const multi = anchors.describe(
  [page1, page2],
  7,
  page1.indexOf('own'),
  page2.indexOf(' A shared'),
).anchor;
match = await anchors.resolve(multi, pdf([...Array(6).fill(filler(0)), page1, page2]));
assert.equal(match.method, 'position');
assert.deepEqual(
  match.segments.map((s) => s.page),
  [7, 8],
);
match = await anchors.resolve(multi, pdf([filler(0), page1, page2]));
assert.equal(match.method, 'document-quote');
assert.deepEqual(
  match.segments.map((s) => s.page),
  [2, 3],
);
console.log('PASS restore: highlights that cross a page break restore on both pages');

assert.deepEqual(
  anchors.mergeRects([
    { page: 2, pdf: [72, 700, 120, 712] },
    { page: 2, pdf: [120.004, 712, 200, 700] },
    { page: 2, pdf: [72, 686, 150, 698] },
    { page: 3, pdf: [72, 700, 90, 712] },
    { page: 3, pdf: [90, 700, 90, 712] },
    { page: 3, pdf: [1, 2, NaN, 4] },
    { pdf: [1, 2, 3, 4] },
  ]),
  [
    { page: 2, pdf: [72, 700, 200, 712] },
    { page: 2, pdf: [72, 686, 150, 698] },
    { page: 3, pdf: [72, 700, 90, 712] },
  ],
);
assert.equal(
  anchors.mergeRects(
    Array.from({ length: 300 }, (_, i) => ({ page: 1, pdf: [0, i * 20, 10, i * 20 + 10] })),
  ).length,
  200,
);
assert.deepEqual(anchors.context('x'.repeat(2000) + '  before', 'after  ' + 'y'.repeat(2000)), {
  before: 'x'.repeat(1492) + '  before',
  after: 'after  ' + 'y'.repeat(1493),
});
assert.deepEqual(anchors.context('  a', 'b  '), { before: 'a', after: 'b' });
console.log('PASS PDF rects are normalized, rounded and merged per line; context is bounded');

assert.deepEqual(
  cleanPdfAnchor({
    kind: 'pdf',
    page: 3,
    endPage: 4,
    quote: { exact: 'text', prefix: 'p'.repeat(100), suffix: 's', extra: 1 },
    textLayer: { start: 5, end: 9, node: 'x' },
    rects: [
      { page: 3, pdf: [1.234, 2, 3, 4], extra: true },
      { page: 9, pdf: [1, 2, 3, 4] },
      { page: 4, pdf: [1, 2, 3] },
      { page: 4, pdf: [1, 2, 3, Infinity] },
    ],
    dom: { start: {} },
  }),
  {
    kind: 'pdf',
    page: 3,
    endPage: 4,
    quote: { exact: 'text', prefix: 'p'.repeat(64), suffix: 's' },
    textLayer: { start: 5, end: 9 },
    rects: [{ page: 3, pdf: [1.23, 2, 3, 4] }],
  },
);
assert.deepEqual(
  cleanPdfAnchor({ kind: 'pdf', page: 2, endPage: 2, quote: { exact: 'x' }, textLayer: {} }),
  { kind: 'pdf', page: 2, quote: { exact: 'x', prefix: '', suffix: '' } },
);
for (const bad of [
  null,
  { kind: 'pdf', page: 2, endPage: 900, quote: { exact: 'x' } },
  { kind: 'pdf', page: 2, endPage: 1, quote: { exact: 'x' } },
  { kind: 'pdf', page: 2, endPage: '3', quote: { exact: 'x' } },
  { kind: 'web', page: 1, quote: { exact: 'x' } },
  { kind: 'pdf', page: 0, quote: { exact: 'x' } },
  { kind: 'pdf', page: 1.5, quote: { exact: 'x' } },
  { kind: 'pdf', page: 1, quote: { exact: '  ' } },
])
  assert.equal(cleanPdfAnchor(bad), null);
console.log('PASS PDF anchors are reshaped and bounded before reaching the vault');
