// Connector errors shown in the UI are mapped by code, in English and Chinese.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../user-error.js';

const root = new URL('../_locales/', import.meta.url);
const locales = {
  en: JSON.parse(fs.readFileSync(new URL('en/messages.json', root))),
  zh_CN: JSON.parse(fs.readFileSync(new URL('zh_CN/messages.json', root))),
};
const keys = [
  'errorVaultUnwritable',
  'errorVaultUnwritableFolder',
  'errorDiskFull',
  'errorDiskFullFolder',
  'errorNotFound',
  'errorInvalidParams',
  'errorInvalidHighlight',
  'errorIo',
  'errorTimeout',
  'errorDisconnected',
  'errorHostMissing',
  'errorInternal',
  'errorGeneric',
];
for (const key of keys) {
  assert.equal(typeof locales.en[key]?.message, 'string', key);
  assert.equal(typeof locales.zh_CN[key]?.message, 'string', key);
  assert.notEqual(locales.en[key].message, locales.zh_CN[key].message, key);
}

function translate(messages) {
  return (key, ...args) => {
    const template = messages[key]?.message;
    if (!template) return key;
    return template.replace(/\$(\d+)/g, (_, index) => args[Number(index) - 1] ?? '');
  };
}

const explain = globalThis.tabgentExplainError;
const codes = [
  'vault_unwritable',
  'disk_full',
  'not_found',
  'invalid_params',
  'invalid_highlight',
  'io_error',
  'timeout',
  'disconnected',
  'host_missing',
  'internal_error',
  'unknown_method',
];
const leaked = /\/|\\|Permission denied|No space left|Invalid highlight|Cannot create|Cannot lock/;

for (const [name, messages] of Object.entries(locales)) {
  const t = translate(messages);
  for (const code of codes) {
    const text = explain(
      { code, message: 'Permission denied: /tmp/secret/ReadingVault/Articles' },
      t,
    );
    assert.doesNotMatch(text, leaked, `${name} ${code}: ${text}`);
    if (!['internal_error', 'unknown_method'].includes(code))
      assert.notEqual(text, messages.errorGeneric.message, `${name} ${code}`);
  }
  const named = explain(
    {
      code: 'vault_unwritable',
      message: 'Cannot create the folder: Permission denied: /tmp/secret/ReadingVault',
      folder: 'Articles',
    },
    t,
  );
  assert.match(named, /Articles/);
  assert.doesNotMatch(named, leaked);
  const full = explain(
    {
      code: 'disk_full',
      message: 'No space left on device: /Users/me/ReadingVault/Articles/article-x',
      folder: 'article-耳夹式无线耳机体验-f634ae3a',
    },
    t,
  );
  assert.match(full, /耳夹式无线耳机体验/);
  assert.doesNotMatch(full, /Users|ReadingVault|No space/);
  for (const folder of ['../etc', 'a/b', 'a\\b', 'a..b', '/tmp/ReadingVault', '.', '..']) {
    const text = explain({ code: 'vault_unwritable', folder, message: 'x' }, t);
    assert.equal(text, messages.errorVaultUnwritable.message, `${name} ${folder}`);
    assert.doesNotMatch(text, /etc|tmp|ReadingVault|\.\./);
  }
  assert.equal(
    explain({ message: 'Invalid highlight' }, t),
    messages.errorInvalidHighlight.message,
  );
  assert.equal(
    explain(
      { message: 'Cannot create the folder: Permission denied: /Users/me/ReadingVault/Articles' },
      t,
    ),
    messages.errorVaultUnwritable.message,
  );
  assert.equal(explain({ message: 'Disk is busy' }, t), 'Disk is busy');
  assert.equal(explain({ code: 'io_error', message: 'Disk is busy' }, t), messages.errorIo.message);
}
assert.equal(locales.zh_CN.errorDisconnected.message, '连接器不可用');
assert.equal(locales.zh_CN.errorVaultUnwritableFolder.message, '无法写入文件夹“$1”');
console.log('PASS connector errors are explained by code in English and Chinese');
