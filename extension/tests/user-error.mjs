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
  'errorPathNotAbsolute',
  'errorPathEmpty',
  'errorNoText',
  'errorTooLong',
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
  'path_not_absolute',
  'path_empty',
  'no_text',
  'too_long',
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
    // The full-path hint itself contains a slash. It must still hide the rejected path.
    if (code === 'path_not_absolute') {
      assert.doesNotMatch(text, /tmp|secret|ReadingVault|Permission denied/);
    } else assert.doesNotMatch(text, leaked, `${name} ${code}: ${text}`);
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
  assert.equal(
    explain({ code: 'path_not_absolute', message: 'path must be absolute: /Users/me/notes' }, t),
    messages.errorPathNotAbsolute.message,
  );
  assert.doesNotMatch(
    explain({ code: 'path_not_absolute', message: 'path must be absolute: /Users/me/notes' }, t),
    /Users|must be absolute/,
  );
  assert.equal(
    explain({ code: 'path_empty', message: 'path must be a non-empty string' }, t),
    messages.errorPathEmpty.message,
  );
  assert.equal(
    explain({ code: 'no_text', message: 'The item has no text to save' }, t),
    messages.errorNoText.message,
  );
  assert.equal(
    explain({ code: 'too_long', message: 'The item is too long to save' }, t),
    messages.errorTooLong.message,
  );
  assert.equal(
    explain({ message: 'path must be absolute' }, t),
    messages.errorPathNotAbsolute.message,
  );
  assert.equal(
    explain({ message: 'The item has no text to save' }, t),
    messages.errorNoText.message,
  );
  assert.equal(
    explain({ message: 'The item is too long to save' }, t),
    messages.errorTooLong.message,
  );
  assert.notEqual(messages.errorNoText.message, messages.errorInvalidParams.message);
  assert.notEqual(messages.errorTooLong.message, messages.errorInvalidParams.message);
  assert.notEqual(messages.errorPathEmpty.message, messages.errorInvalidParams.message);
}
assert.equal(locales.zh_CN.errorDisconnected.message, '连接器不可用');
assert.equal(locales.zh_CN.errorVaultUnwritableFolder.message, '无法写入文件夹“$1”');
assert.equal(locales.zh_CN.errorNoText.message, '条目为空');
assert.equal(locales.zh_CN.errorTooLong.message, '正文过长');
assert.equal(locales.zh_CN.errorPathNotAbsolute.message, '请填写以 / 或 ~ 开头的完整路径');
assert.equal(locales.zh_CN.errorPathEmpty.message, '请填写资料库文件夹');
assert.equal(
  locales.en.errorPathNotAbsolute.message,
  'Enter a full folder path that starts with / or ~',
);
console.log('PASS connector errors are explained by code in English and Chinese');
