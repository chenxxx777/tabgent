// Vault document folder names. Must match extension/native/vault.py DOCUMENT_ID
// and CHAPTER_FILE. Python 3 \w (no re.ASCII) is Unicode letters and numbers plus
// underscore. JavaScript \w is ASCII-only, so this uses \p{L}\p{N}. The id body is
// at most 160 characters and a generated slug is at most 48, both vault.py's limits.
// Hyphen is the separator. Slash, backslash, dot, whitespace and controls are not
// word characters, so they cannot appear in an id or a chapter file name.
export const DOCUMENT_ID = /^(?:article|paper|book)-[\p{L}\p{N}_-]{1,160}$/u;
export const CHAPTER_FILE = /^chapters\/\d{2,}-[\p{L}\p{N}_-]{1,48}\.md$/u;

export function isDocumentId(value) {
  return typeof value === 'string' && DOCUMENT_ID.test(value);
}

export function isChapterFile(value) {
  return typeof value === 'string' && CHAPTER_FILE.test(value);
}
