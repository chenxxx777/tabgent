# PDF.js 6.4.299

Vendored from the official Mozilla release:
https://github.com/mozilla/pdf.js/releases/download/v6.4.299/pdfjs-6.4.299-dist.zip

License: Apache-2.0; see LICENSE and individual resource notices.

The viewer, library, worker, fonts, CMaps, ICC profiles, images, and WASM are
bundled locally. Source maps, the sample PDF, debugging tools, scripting sandbox,
and translations other than en-US are omitted. `web/locale/locale.json` is
restricted to en-US. One local change in `web/viewer.mjs` forwards errors from
the recursive print-rendering promise to the print job, so cancelling between
pages does not leave an unhandled rejection. `extension/tests/pdf-print.cjs`
checks cancellation and normal completion.

Tabgent's wrapper disables PDF JavaScript, remote model downloads,
and document replacement through the viewer. Integration lives in `extension/pdf/`.
