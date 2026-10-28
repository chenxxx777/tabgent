// Exercise the bundled PDF.js service, including cancellation *between* rendered pages.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../vendor/pdfjs/web/viewer.mjs'), 'utf8');
const service = source.slice(
  source.indexOf('class PDFPrintService {'),
  source.indexOf('const print = window.print;'),
);
let active = true,
  rendered = 0;
const PDFPrintService = vm.runInNewContext(service + '\nPDFPrintService', {
  renderPage: async () => {},
  renderProgress: () => {},
});
const job = Object.create(PDFPrintService.prototype);
Object.assign(job, {
  pdfDocument: {},
  pagesOverview: [{}, {}],
  currentPage: -1,
  throwIfInactive() {
    if (!active) throw Error('This print request was cancelled or completed.');
  },
  useRenderedPage: async () => {
    rendered++;
    active = false;
  },
});
(async () => {
  await assert.rejects(job.renderPages(), /This print request was cancelled or completed/);
  assert.equal(rendered, 1);
  active = true;
  rendered = 0;
  job.currentPage = -1;
  job.useRenderedPage = async () => {
    rendered++;
  };
  await job.renderPages();
  assert.equal(rendered, 2, 'Normal printing still renders every page');
  console.log('PASS PDF print cancellation rejects the owned promise; normal rendering completes');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
