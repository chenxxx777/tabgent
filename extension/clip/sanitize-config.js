// DOMPurify settings for clipped pages, shared by the clipping script (before the text is
// stored) and the clipped-page reader (before it is shown). A clipped page is untrusted:
// only text structure, links and images Tabgent resolves itself are kept.
(() => {
  if (globalThis.tabgentClipSanitize) return;
  const MATH = (
    'math mi mn mo ms mtext mspace mrow mfrac msqrt mroot msub msup msubsup munder mover ' +
    'munderover mtable mtr mtd mstyle mpadded mphantom menclose mmultiscripts mprescripts ' +
    'none semantics annotation'
  ).split(' ');
  const config = Object.freeze({
    ALLOWED_TAGS: [
      ...(
        'a abbr b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div ' +
        'dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q rp ' +
        'rt ruby s samp section small span strong sub summary sup table tbody td tfoot th ' +
        'thead time tr u ul var'
      ).split(' '),
      ...MATH,
    ],
    ALLOWED_ATTR: [
      ...(
        'href alt title width height colspan rowspan scope headers datetime lang dir start ' +
        'reversed open id display mathvariant encoding'
      ).split(' '),
      // Tabgent's own: an image's remote address (not loaded) or its vault copy, and LaTeX.
      'data-remote-src',
      'data-tabgent-asset',
      'data-latex',
      'data-language',
    ],
    FORBID_TAGS: [
      ...(
        'script style link meta base form input button select option textarea iframe frame ' +
        'object embed svg video audio source track picture canvas template noscript dialog'
      ).split(' '),
    ],
    FORBID_ATTR: ['style', 'class', 'src', 'srcset', 'name'],
    // DOMPurify checks other attribute values against ALLOWED_URI_REGEXP; these hold plain
    // values, never addresses.
    ADD_URI_SAFE_ATTR: [
      ...(
        'width height colspan rowspan scope headers datetime lang dir start reversed open ' +
        'display mathvariant encoding'
      ).split(' '),
      'data-latex',
      'data-language',
      'data-tabgent-asset',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // Links only: web and mail addresses and fragments within the page.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  });
  // Remote image addresses are kept as data, never loaded: only http(s), bounded.
  const remote = (value) =>
    typeof value === 'string' && value.length <= 4096 && /^https?:\/\//i.test(value);
  globalThis.tabgentClipSanitize = Object.freeze({ config, remote });
})();
