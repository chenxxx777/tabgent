# Turndown

Copied unmodified from the npm package `turndown@7.2.4`
(`lib/turndown.browser.umd.js`) as `turndown.js`. License: MIT; see `LICENSE`.

Tabgent injects it with the clipping script to convert a clipped page's cleaned HTML to
Markdown. Table and strikethrough rules are Tabgent's own (`extension/clip/`).

## Updating

1. Update the exact version of `turndown` in `package.json` and run `npm install`.
2. Copy `node_modules/turndown/lib/turndown.browser.umd.js` to `turndown.js` and its
   `LICENSE` here.
3. Update the version here and in `THIRD_PARTY_NOTICES.md`, then run `npm test` and
   `npm run test:clip`.
