# foliate-js (EPUB subset)

Vendored from https://github.com/johnfactotum/foliate-js at commit
`78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01). foliate-js has no
releases or build step; the commit is the version.

License: MIT; see `LICENSE`. `vendor/zip.js` is the minified zip.js build that
foliate-js ships at that commit (from `@zip.js/zip.js` 2.8.22 per its
`package-lock.json`), under BSD-3-Clause; see `vendor/zip.js.LICENSE`.

Included, unmodified: `view.js`, `epub.js`, `epubcfi.js`, `paginator.js`,
`fixed-layout.js`, `overlayer.js`, `progress.js`, `text-walker.js` and
`vendor/zip.js`. Omitted: other formats (MOBI, FB2, CBZ, PDF), TTS, search,
dictionary, OPDS, the demo reader and UI, tests and `vendor/fflate.js`.
`view.js` still names the omitted modules in dynamic imports, but Tabgent passes
an already opened EPUB to `View.open()`, so they are never requested.

Tabgent's reader (`extension/epub/`) disables EPUB scripts: script resources are
not loaded, `<script>` elements are neutralized by type (so CFIs stay stable),
event handler attributes and `javascript:` URLs are removed, and the extension
CSP plus the reader's own CSP block script execution and remote resources.

## Updating

1. Clone foliate-js and check out the new commit.
2. Copy the files listed above, `LICENSE` and `vendor/zip.js` over these.
3. Check `package-lock.json` for the bundled zip.js version and refresh
   `vendor/zip.js.LICENSE` from that npm package.
4. Update the commit here and in `THIRD_PARTY_NOTICES.md`, then run `npm test`
   and `npm run test:epub`.
