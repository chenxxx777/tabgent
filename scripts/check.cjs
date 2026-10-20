const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      ['__pycache__', 'vendor'].includes(e.name)
        ? []
        : e.isDirectory()
          ? walk(path.join(dir, e.name))
          : [path.join(dir, e.name)],
    );
}
for (const file of [...walk('extension'), ...walk('scripts')]) {
  if (/\.(?:js|cjs|mjs)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
  // Noncharacters and specials are invisible in diffs and tools may strip them: escape them.
  if (/\.(?:js|cjs|mjs|json|html|css|py)$/.test(file))
    assert(
      !/[\uFDD0-\uFDEF\uFFF0-\uFFFF]/.test(fs.readFileSync(file, 'utf8')),
      `Write U+FDD0-U+FDEF and U+FFF0-U+FFFF as escapes in ${file}`,
    );
  if (file.endsWith('.py')) {
    const result = spawnSync(
      process.env.PYTHON || 'python3',
      ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', file],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
const messages = JSON.parse(fs.readFileSync('extension/_locales/en/messages.json', 'utf8'));
for (const file of walk('extension').filter((f) => /\.(html|js)$/.test(f))) {
  const text = fs.readFileSync(file, 'utf8');
  const keys = [...text.matchAll(/\$i18n\{([A-Za-z0-9_]+)\}|\b(?:i18n|t)\('([^']+)'(?=\s*[,\)])/g)];
  for (const match of keys)
    assert(messages[match[1] || match[2]], `Missing English string in ${file}: ${match[0]}`);
}
// Stored quotes start with this marker and are recognized by it later, so a
// translation would hide quotes saved under another browser language.
for (const locale of fs.readdirSync('extension/_locales')) {
  const quote = JSON.parse(fs.readFileSync(`extension/_locales/${locale}/messages.json`, 'utf8'))
    .selectionQuote?.message;
  assert(
    !quote || quote === messages.selectionQuote.message,
    `Translated selectionQuote in ${locale}`,
  );
}
assert.equal(
  JSON.parse(fs.readFileSync('package.json')).version,
  JSON.parse(fs.readFileSync('extension/manifest.json')).version,
);
console.log(
  'PASS syntax, JSON, escaped noncharacters, localization references, and release version',
);
