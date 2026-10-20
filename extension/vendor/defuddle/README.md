# Defuddle (core browser bundle)

Copied unmodified from the npm package `defuddle@0.19.5` (`dist/index.js`, the core UMD
bundle with no dependencies) as `defuddle.js`. License: MIT; see `LICENSE`.

Tabgent injects it into a page only when the user clips that page, and calls the
synchronous `parse()` with `useAsync: false`, so its extractors read the rendered page
and never fetch from third-party services (its `parseAsync()` fallbacks are not used).

## Updating

1. Update the exact version of `defuddle` in `package.json` and run `npm install`.
2. Copy `node_modules/defuddle/dist/index.js` to `defuddle.js` and its `LICENSE` here.
3. Update the version here and in `THIRD_PARTY_NOTICES.md`, then run `npm test` and
   `npm run test:clip`, and check the clipping checklist in `docs/development.md`.
