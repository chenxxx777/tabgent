# foliate-js (EPUB subset)

Vendored from https://github.com/johnfactotum/foliate-js at commit
`78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01). foliate-js has no
releases or build step; the commit is the version.

License: MIT; see `LICENSE`. `vendor/zip.js` is the minified zip.js build that
foliate-js ships at that commit (from `@zip.js/zip.js` 2.8.22 per its
`package-lock.json`), under BSD-3-Clause; see `vendor/zip.js.LICENSE`.

Included: `view.js`, `epub.js`, `epubcfi.js`, `paginator.js`,
`fixed-layout.js`, `overlayer.js`, `progress.js`, `text-walker.js` and
`vendor/zip.js`. Omitted: other formats (MOBI, FB2, CBZ, PDF), TTS, search,
dictionary, OPDS, the demo reader and UI, tests and `vendor/fflate.js`.
`view.js` still names the omitted modules in dynamic imports, but Tabgent passes
an already opened EPUB to `View.open()`, so they are never requested.

Tabgent's reader (`extension/epub/`) disables EPUB scripts: script resources are
not loaded, `<script>` elements are neutralized by type (so CFIs stay stable),
event handler attributes and `javascript:` URLs are removed, and the extension
CSP plus the reader's own CSP block script execution and remote resources.

## Tabgent patches

- `paginator.js` and `fixed-layout.js` use the small local `frame.js` helper to
  accept `{ srcdoc }` section sources as well as upstream URL strings. The EPUB
  adapter in `extension/epub/book.js` fetches foliate's already rewritten and
  sanitized chapter blobs and supplies HTML `srcdoc`; image/CSS/font resources
  still use foliate's blob cache and unload lifecycle. Sandbox permissions and
  the reader CSP are retained.
- `frame.js` ignores the initial `about:blank` load, rejects inaccessible
  documents/load errors and times out after 15 seconds. Layout callbacks run in
  the awaiting async function so their exceptions reject instead of leaving an
  unresolved DOM-listener promise. `view.js` propagates navigation errors to the
  reader. The reader returns to the library with a persistent error and allows
  another import; unsuccessful rendering starts no vault upload.
- `paginator.js` stops swallowing section-source failures and guards pending
  layout/font/animation callbacks against missing or closed chapter views.

These patches address B1: Chromium 151's `MigrateAutomaticJsOptimizer` field trial
(`MigrateToBlockV8OptimizerOnUnfamiliarSites`) makes an extension-created blob
chapter a separate frame process that the parent cannot access, despite its
matching serialized origin. Playwright's `--disable-field-trial-config` hides
this path. Using `srcdoc` retains the embedding document's context without
changing browser security settings. This also matters to branded Chrome when
unfamiliar-site JavaScript optimizer blocking is enabled: the same failure can
be reproduced without field trials by setting the temporary profile preference
`safebrowsing.javascript_optimizer_blocked_for_unfamiliar_sites` to `true`.
The everyday Chrome profile is not needed for this compatibility check. Recheck these patches when updating the
vendor and run `npm run test:epub` (direct Chrome launch plus CDP, headed on macOS;
`EPUB_HEADLESS=1` also exercises direct headless Chrome).

## Updating

1. Clone foliate-js and check out the new commit.
2. Copy the files listed above, `LICENSE` and `vendor/zip.js` over these.
3. Check `package-lock.json` for the bundled zip.js version and refresh
   `vendor/zip.js.LICENSE` from that npm package.
4. Update the commit here and in `THIRD_PARTY_NOTICES.md`, then run `npm test`
   and `npm run test:epub`.
