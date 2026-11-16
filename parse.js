// A faster drop-in for marked 18.1.3: parse(markdown) returns exactly what
// marked.parse(markdown) returns with its default options (gfm on, breaks off,
// pedantic off, async off). Whatever the fast path cannot prove identical falls
// back to the vendored marked (vendor/marked/, MIT), so the answer is always
// marked's. The emphasis delimiter search follows marked's algorithm.

import { marked } from './vendor/marked/marked.esm.js';

const FALLBACK = Symbol('fallback');
let fallbackCount = 0;

export function stats() {
  return fallbackCount;
}

/* ------------------------------------------------------------------ helpers */

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|' +
  'dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|' +
  'hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|' +
  'search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_SET = new Set(BLOCK_TAGS.split('|').filter((t) => !t.includes('[')));
function isBlockTagName(name) {
  if (name.length === 2 && (name[0] === 'h' || name[0] === 'H') && name[1] >= '1' && name[1] <= '6') return true;
  return BLOCK_TAG_SET.has(name.toLowerCase());
}
function rawBlockName(line) {
  for (const name of ["script", "pre", "style", "textarea"]) {
    if (line.startsWith("<" + name)) {
      const c = 1 + name.length < line.length ? line.charCodeAt(1 + name.length) : 10;
      if (c === 62 || c === 32 || c === 9 || c === 10) return name;
    }
  }
  return null;
}
function blockTagRest(rest) {
  if (rest.length === 0) return true;
  const c = rest.charCodeAt(0);
  if (c === 32 || c === 9 || c === 62) return true;
  return rest.startsWith('/>');
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (c) => ESC_MAP[c];
const RE_ESC_TEST = /[&<>"']/;
const RE_ESC_REPLACE = /[&<>"']/g;
const RE_ESC_TEST_NO = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ESC_REPLACE_NO = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUM_REF_OR_AMP =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function esc(s, encode) {
  if (encode) {
    if (RE_ESC_TEST.test(s)) return s.replace(RE_ESC_REPLACE, escChar);
  } else if (RE_ESC_TEST_NO.test(s)) {
    return s.replace(RE_ESC_REPLACE_NO, escChar);
  }
  return s;
}

function unescapeEntities(s) {
  if (!RE_NUM_REF.test(s)) return s;
  return s.replace(RE_NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function labelKey(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function rtrimChar(s, ch) {
  const code = typeof ch === 'number' ? ch : ch.charCodeAt(0);
  let k = 0;
  const n = s.length;
  while (k < n && s.charCodeAt(n - k - 1) === code) k++;
  return k ? s.slice(0, n - k) : s;
}

function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimBlankTail(raw) {
  const parts = raw.split('\n');
  let t = parts.length - 1;
  while (t >= 0 && isBlankStr(parts[t])) t--;
  return parts.length - t <= 2 ? raw : parts.slice(0, t + 1).join('\n');
}

function expandTabs(s, start) {
  let col = start;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 9) {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else {
      out += s[i];
      col++;
    }
  }
  return out;
}

function expandLeadingTabs(s) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i === 0) return s;
  return expandTabs(s.slice(0, i), 0) + s.slice(i);
}

const RE_CODE_INDENT = /^(?: {0,3}\t| {1,4})/;
function stripCodeIndent(raw) {
  let out = '';
  let i = 0;
  const n = raw.length;
  let lineStart = true;
  while (i < n) {
    if (lineStart) {
      lineStart = false;
      let j = i;
      let sp = 0;
      while (j < n && sp < 3 && raw.charCodeAt(j) === 32) {
        j++;
        sp++;
      }
      if (j < n && raw.charCodeAt(j) === 9) {
        i = j + 1;
      } else {
        let k = i;
        let s2 = 0;
        while (k < n && s2 < 4 && raw.charCodeAt(k) === 32) {
          k++;
          s2++;
        }
        i = k;
      }
      continue;
    }
    const c = raw.charCodeAt(i);
    if (c === 10) {
      out += '\n';
      lineStart = true;
      i++;
      continue;
    }
    out += raw[i];
    i++;
  }
  return out;
}

function fenceCode(raw, text) {
  const m = /^(\s+)(?:```)/.exec(raw);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      let k = 0;
      while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
      if (k === 0) return line;
      return line.slice(Math.min(k, indent.length));
    })
    .join('\n');
}

/* --------------------------------------------------------------- char class */

const RE_PUNCT_ONE = /[\p{P}\p{S}]/u;
const RE_ALNUM_ONE = /[\p{L}\p{N}]/u;
const RE_WS_ONE = /\s/u;

function isPunctChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  return RE_PUNCT_ONE.test(ch);
}

const RE_PUNCT_SPACE_ONE = /[\s\p{P}\p{S}]/u;
function isPunctOrSpace(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) || c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
  }
  return RE_PUNCT_SPACE_ONE.test(ch);
}

function isSpaceChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
  return RE_WS_ONE.test(ch);
}

function isAlnumChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return RE_ALNUM_ONE.test(ch);
}

/* ------------------------------------------------------------------- blocks */

export function parse(markdown) {
  if (typeof markdown !== 'string') return marked.parse(markdown);
  try {
    return renderDocument(markdown);
  } catch (e) {
    fallbackCount++;
    return marked.parse(markdown);
  }
}

function renderDocument(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const doc = {
    links: Object.create(null),
    state: { inLink: false, inRawBlock: false, linkParenPossible: true, top: true },
    linkEmitted: false,
  };
  const tokens = blockTokens(src, doc, true);
  return renderTokens(tokens, doc);
}

function lineEnd(src, i) {
  const j = src.indexOf('\n', i);
  return j < 0 ? src.length : j;
}

function countSpaces(src, i, end) {
  let k = 0;
  while (i + k < end && src.charCodeAt(i + k) === 32) k++;
  return k;
}

function isHrLine(src, i, max, end) {
  const sp = countSpaces(src, i, end);
  if (sp > max) return false;
  let j = i + sp;
  if (j >= end) return false;
  const ch = src.charCodeAt(j);
  if (ch !== 45 && ch !== 95 && ch !== 42) return false;
  let count = 0;
  for (; j < end; j++) {
    const c = src.charCodeAt(j);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

function isHeadingLine(src, i, max, end) {
  const sp = countSpaces(src, i, end);
  if (sp > max) return false;
  let j = i + sp;
  let k = 0;
  while (j < end && src.charCodeAt(j) === 35 && k < 7) {
    j++;
    k++;
  }
  if (k < 1 || k > 6) return false;
  if (j >= end) return true;
  const c = src.charCodeAt(j);
  return c === 32 || c === 9;
}

function isQuoteLine(src, i, max, end) {
  const sp = countSpaces(src, i, end);
  return sp <= max && i + sp < end && src.charCodeAt(i + sp) === 62;
}

function isFenceLine(src, i, max, end) {
  const sp = countSpaces(src, i, end);
  if (sp > max) return false;
  let j = i + sp;
  if (j >= end) return false;
  const ch = src.charCodeAt(j);
  if (ch !== 96 && ch !== 126) return false;
  let k = 0;
  while (j < end && src.charCodeAt(j) === ch) {
    j++;
    k++;
  }
  if (k < 3) return false;
  if (ch === 96) for (; j < end; j++) if (src.charCodeAt(j) === 96) return false;
  return true;
}

function isBulletLine(src, i, max, end) {
  const sp = countSpaces(src, i, end);
  if (sp > max) return false;
  let j = i + sp;
  const ch = src.charCodeAt(j);
  if (ch === 42 || ch === 43 || ch === 45) j++;
  else if (ch >= 48 && ch <= 57) {
    let d = 0;
    while (j < end && d < 9) {
      const c = src.charCodeAt(j);
      if (c < 48 || c > 57) break;
      j++;
      d++;
    }
    if (d === 0) return false;
    const c2 = src.charCodeAt(j);
    if (c2 !== 46 && c2 !== 41) return false;
    j++;
  } else return false;
  if (j >= end) return true;
  const c = src.charCodeAt(j);
  return c === 32 || c === 9 || c === 10;
}

function isParagraphListLine(src, i, max, end) {
  const sp = countSpaces(src, i, end);
  if (sp > max) return false;
  let j = i + sp;
  const ch = src.charCodeAt(j);
  if (ch === 42 || ch === 43 || ch === 45) j++;
  else if (ch === 49) {
    const c2 = src.charCodeAt(j + 1);
    if (c2 !== 46 && c2 !== 41) return false;
    j += 2;
  } else return false;
  let ws = 0;
  while (j < end) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9) {
      j++;
      ws++;
    } else break;
  }
  if (ws === 0 || j >= end) return false;
  const c = src.charCodeAt(j);
  return c !== 10 && c !== 32 && c !== 9;
}

const RE_CLOSE_TAG_LINE = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>[ \t]*$/;
const RE_OPEN_TAG_LINE = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>[ \t]*$/;
const RE_TAG_NAME = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;

function isHtmlLine(src, i, max, end, single) {
  const sp = countSpaces(src, i, end);
  if (sp > max) return false;
  const j = i + sp;
  if (j >= end || src.charCodeAt(j) !== 60) return false;
  const line = src.slice(j, end);
  const c1 = line.charCodeAt(1);
  if (c1 !== 47 && rawBlockName(line)) return true;
  if (c1 === 47 || (c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
    const m = RE_TAG_NAME.exec(line);
    if (!m) return false;
    const after = line.slice(m[0].length);
    if (isBlockTagName(m[1]) && blockTagRest(after)) return true;
    if (!single) return false;
    const tagged = m[0][1] === "/";
    if (tagged && RE_CLOSE_TAG_LINE.test(line)) return true;
    if (!tagged && RE_OPEN_TAG_LINE.test(line)) return true;
    return false;
  }
  if (c1 === 33) {
    return line.startsWith('<!--') || line.startsWith('<![CDATA[') || /^<![A-Za-z]/.test(line);
  }
  if (c1 === 63) return true;
  return false;
}

const RE_TABLE_DELIM_LINE = /^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

function isTableDelimLine(src, i, max, end) {
  const sp = countSpaces(src, i, end);
  if (sp > max) return false;
  return RE_TABLE_DELIM_LINE.test(src.slice(i + sp, end));
}

function startsBlock(src, i, end) {
  if (i >= end) return false;
  let j = i;
  const sp = countSpaces(src, i, end);
  if (sp > 0) {
    if (sp > 3) return false;
    j = i + sp;
    if (j >= end) return false;
  }
  const c = src.charCodeAt(j);
  const le = lineEnd(src, j);
  if (c === 60) return isHtmlLine(src, j, 0, le);
  if (c === 35) return isHeadingLine(src, j, 0, le);
  if (c === 62) return true;
  if (c === 45 || c === 95 || c === 42) {
    if (isHrLine(src, j, 0, le)) return true;
    return isParagraphListLine(src, j, 0, le);
  }
  if (c === 96 || c === 126) return isFenceLine(src, j, 0, le);
  if (c >= 48 && c <= 57) return isParagraphListLine(src, j, 0, le);
  return false;
}

function startsTable(src, i, end) {
  const eol = lineEnd(src, i);
  if (eol >= end) return false;
  if (i >= end || src.charCodeAt(i) === 32) return false;
  const next = eol + 1;
  if (next >= end) return false;
  return isTableDelimLine(src, next, 3, lineEnd(src, next));
}

/* -------------------------------------------------------------- tokenizers */

function trySpace(src, p) {
  const n = src.length;
  let q = p;
  let matched = false;
  while (q < n) {
    let r = q;
    while (r < n) {
      const c = src.charCodeAt(r);
      if (c === 32 || c === 9) r++;
      else break;
    }
    if (r < n && src.charCodeAt(r) === 10) {
      q = r + 1;
      matched = true;
      continue;
    }
    if (r >= n) {
      q = n;
      matched = true;
      break;
    }
    break;
  }
  if (!matched) return null;
  return [q, { type: 'space', raw: src.slice(p, q) }];
}

function tryCode(src, p) {
  const n = src.length;
  let q = p;
  let any = false;
  for (;;) {
    const eol = lineEnd(src, q);
    let j = q;
    let sp = 0;
    while (j < eol && sp < 4 && src.charCodeAt(j) === 32) {
      j++;
      sp++;
    }
    let indented = false;
    if (sp === 4 && j < eol) indented = true;
    else if (j < eol && src.charCodeAt(j) === 9 && sp < 4) indented = true;
    if (!indented) break;
    any = true;
    q = eol < n ? eol + 1 : n;
    for (;;) {
      if (q >= n) break;
      const e2 = lineEnd(src, q);
      if (!isBlankStr(src.slice(q, e2))) break;
      q = e2 < n ? e2 + 1 : n;
    }
    if (q >= n) break;
  }
  if (!any) return null;
  const raw = trimBlankTail(src.slice(p, q));
  return [p + raw.length, { type: 'code', raw, text: stripCodeIndent(raw) }];
}

const RE_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapeBackslashPunct(s) {
  return s.replace(RE_ANY_PUNCT, '$1');
}

function tryFences(src, p) {
  const n = src.length;
  const eol = lineEnd(src, p);
  let j = p;
  const sp = countSpaces(src, p, eol);
  if (sp > 3) return null;
  j = p + sp;
  const ch = src.charCodeAt(j);
  if (ch !== 96 && ch !== 126) return null;
  let k = 0;
  while (j < eol && src.charCodeAt(j) === ch) {
    j++;
    k++;
  }
  if (k < 3) return null;
  if (ch === 96) for (let x = j; x < eol; x++) if (src.charCodeAt(x) === 96) return null;
  const info = src.slice(j, eol);
  const contentStart = eol < n ? eol + 1 : n;
  let closeStart = -1;
  let closeEnd = -1;
  let q = contentStart;
  while (q < n) {
    const le = lineEnd(src, q);
    const s2 = countSpaces(src, q, le);
    let x = q + s2;
    if (s2 <= 3 && x < le && src.charCodeAt(x) === ch) {
      let run = 0;
      while (x < le && src.charCodeAt(x) === ch) {
        x++;
        run++;
      }
      if (run >= k) {
        let y = x;
        while (y < le && (src.charCodeAt(y) === 32 || src.charCodeAt(y) === 9)) y++;
        if (y >= le) {
          closeStart = q;
          closeEnd = le;
          break;
        }
      }
    }
    q = le < n ? le + 1 : n;
  }
  const rawEnd = closeStart >= 0 ? closeEnd : n;
  let text = src.slice(contentStart, closeStart >= 0 ? closeStart : n);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const raw = src.slice(p, rawEnd);
  const langTrim = info.trim();
  return [
    rawEnd,
    {
      type: 'fence',
      raw,
      text: fenceCode(raw, text),
      lang: langTrim ? unescapeBackslashPunct(langTrim) : info,
    },
  ];
}

function tryHeading(src, p) {
  const n = src.length;
  const eol = lineEnd(src, p);
  const sp = countSpaces(src, p, eol);
  if (sp > 3) return null;
  let j = p + sp;
  let k = 0;
  while (j < eol && src.charCodeAt(j) === 35 && k < 7) {
    j++;
    k++;
  }
  if (k < 1 || k > 6) return null;
  if (j < eol) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  let text = src.slice(j, eol).trim();
  if (text.endsWith('#')) {
    const s = rtrimChar(text, '#');
    if (!s || s.endsWith(' ') || s.endsWith('\t')) text = s.trim();
  }
  return [eol, { type: 'heading', depth: k, text, raw: src.slice(p, eol) }];
}

function tryHr(src, p) {
  const eol = lineEnd(src, p);
  if (!isHrLine(src, p, 3, eol)) return null;
  return [eol, { type: 'hr', raw: src.slice(p, eol) }];
}

function cleanQuote(h) {
  return h
    .replace(/^( {0,3}>)([ \t]+)/gm, (m, b, ws) => b + expandTabs(ws, b.length))
    .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
    .replace(/^ {0,3}>[ \t]?/gm, '');
}

function tryBlockquote(src, p, doc) {
  const n = src.length;
  let q = p;
  let last = p;
  let any = false;
  for (;;) {
    if (q >= n) break;
    const eol = lineEnd(src, q);
    const sp = countSpaces(src, q, eol);
    let j = q + sp;
    if (sp > 3 || j >= n || src.charCodeAt(j) !== 62) break;
    j++;
    if (j < eol && src.charCodeAt(j) === 32) j++;
    any = true;
    const rest = src.slice(j, eol);
    q = eol < n ? eol + 1 : n;
    last = q;
    if (isBlankStr(rest)) continue;
    while (q < n) {
      const le = lineEnd(src, q);
      if (le < n && isBlankStr(src.slice(q, le))) break;
      if (startsBlock(src, q, n)) break;
      q = le < n ? le + 1 : n;
      last = q;
    }
  }
  if (!any) return null;
  const raw = src.slice(p, last);
  const quote = buildQuote(raw, doc);
  return [p + quote.raw.length, quote];
}

function buildQuote(raw, doc) {
  let rest = rtrimChar(raw, '\n').split('\n');
  let s = '';
  let text = '';
  const tokens = [];
  const st = doc.state;
  for (;;) {
    let sawQuote = false;
    const chunk = [];
    let idx = 0;
    for (; idx < rest.length; idx++) {
      const line = rest[idx];
      if (isQuoteLine(line, 0, 3, line.length)) {
        chunk.push(line);
        sawQuote = true;
      } else if (!sawQuote) chunk.push(line);
      else break;
    }
    rest = rest.slice(idx);
    const h = chunk.join('\n');
    const u = cleanQuote(h);
    s = s ? s + '\n' + h : h;
    text = text ? text + '\n' + u : u;
    const top = st.top;
    st.top = true;
    blockTokensInto(u, tokens, true, doc);
    st.top = top;
    if (rest.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (k.type === 'code' || k.type === 'fence' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table') break;
    if (k.type === 'quote') {
      const joined = rest.join('\n');
      const m2 = k.raw + '\n' + joined.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = buildQuote(m2, doc);
      tokens[tokens.length - 1] = f;
      const y = m2.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? rest.slice(0, -R) : rest;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      text = text.substring(0, text.length - k.text.length) + f.text;
      rest = rest.slice(A.length);
      if (rest.length > 0 && isQuoteLine(rest[0], 0, 3, rest[0].length)) continue;
      break;
    } else if (k.type === 'list') {
      const joined = rest.join('\n');
      const m2 = k.raw + '\n' + joined.replace(/^ {0,3}>[ \t]?/gm, '');
      const parsed = blockTokens(m2, doc, true);
      const f = parsed.length === 1 ? parsed[0] : k;
      tokens[tokens.length - 1] = f;
      const count = f.raw.length > k.raw.length ? m2.slice(k.raw.length + 1, f.raw.length).split('\n').length : 0;
      if (count > 0) {
        const y = rest.slice(0, count).join('\n');
        s = s + '\n' + y;
        text = text + '\n' + y;
      }
      rest = rest.slice(count);
      continue;
    }
  }
  return { type: 'quote', raw: s, text, tokens };
}

/* -------------------------------------------------------------------- lists */

function matchItem(src, i, marker) {
  const end = src.length;
  const sp = countSpaces(src, i, end);
  if (sp > 3) return null;
  let j = i + sp;
  if (marker.ordered) {
    let d = 0;
    while (j < end && d < 9) {
      const c = src.charCodeAt(j);
      if (c < 48 || c > 57) break;
      j++;
      d++;
    }
    if (d === 0) return null;
    if (src.charCodeAt(j) !== marker.delim) return null;
    j++;
  } else {
    if (src.charCodeAt(j) !== marker.char) return null;
    j++;
  }
  const markerEnd = j;
  const eol = lineEnd(src, j);
  let restEnd = j;
  if (j < eol) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    restEnd = eol;
  }
  return { markerEnd, restStart: markerEnd, restEnd, lineAfter: eol < end ? eol + 1 : end };
}

function tryList(src, p, doc) {
  const n = src.length;
  const sp = countSpaces(src, p, n);
  if (sp > 3) return null;
  let j = p + sp;
  let markerText;
  const c = src.charCodeAt(j);
  if (c === 42 || c === 43 || c === 45) {
    markerText = src[j];
    j++;
  } else if (c >= 48 && c <= 57) {
    const s0 = j;
    let d = 0;
    while (j < n && d < 9) {
      const cc = src.charCodeAt(j);
      if (cc < 48 || cc > 57) break;
      j++;
      d++;
    }
    if (d === 0) return null;
    const c2 = src.charCodeAt(j);
    if (c2 !== 46 && c2 !== 41) return null;
    markerText = src.slice(s0, j + 1);
    j++;
  } else return null;
  const eol0 = lineEnd(src, j);
  if (j < n && j < eol0) {
    const cc = src.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return null;
  }
  const ordered = markerText.length > 1;
  const marker = ordered
    ? { ordered: true, delim: markerText.charCodeAt(markerText.length - 1) }
    : { ordered: false, char: markerText.charCodeAt(0) };
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +markerText.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  let prevBlank = false;
  let pos = p;
  for (;;) {
    if (pos >= n) break;
    const m = matchItem(src, pos, marker);
    if (!m) break;
    if (isHrLine(src, pos, 3, lineEnd(src, pos))) break;
    const itemStart = pos;
    let e = m.lineAfter;
    const markerLen = m.markerEnd - pos;
    const firstRaw = src.slice(m.restStart, m.restEnd);
    let lead = 0;
    while (lead < firstRaw.length && (firstRaw.charCodeAt(lead) === 32 || firstRaw.charCodeAt(lead) === 9)) lead++;
    let line = expandTabs(firstRaw.slice(0, lead), markerLen) + firstRaw.slice(lead);
    const nextEol = lineEnd(src, e);
    const nextLine = src.slice(e, nextEol);
    let blank = line.trim() === '';
    let R;
    let text;
    if (blank) {
      R = markerLen + 1;
      text = '';
    } else {
      const ns = line.search(/[^ ]/);
      R = ns < 0 ? line.length : ns;
      if (R > 4) R = 1;
      text = line.slice(R);
      R += markerLen;
    }
    let done = false;
    if (blank && isBlankStr(nextLine)) {
      e = nextEol < n ? nextEol + 1 : n;
      done = true;
    }
    if (!done) {
      for (;;) {
        if (e >= n) break;
        const eol = lineEnd(src, e);
        const U = src.slice(e, eol);
        const Z = expandLeadingTabs(U);
        const lim = Math.max(0, Math.min(3, R - 1));
        if (
          isFenceLine(src, e, lim, eol) ||
          isHeadingLine(src, e, lim, eol) ||
          isHtmlLine(src, e, lim, eol) ||
          isQuoteLine(src, e, lim, eol) ||
          isBulletLine(src, e, lim, eol) ||
          isHrLine(src, e, lim, eol)
        )
          break;
        const ns = Z.search(/[^ ]/);
        if (ns >= R || U.trim() === '') {
          text += '\n' + Z.slice(R);
        } else {
          const lineNoTabs = line.replace(/\t/g, '    ');
          if (
            blank ||
            lineNoTabs.search(/[^ ]/) >= 4 ||
            isFenceStr(line, 3) ||
            isHeadingStr(line, 3) ||
            isHtmlStr(line, 3) ||
            isHrStr(line, 3)
          )
            break;
          if (/^ {0,3}(?:=+|-+) *$/.test(U) && !isHeadingLikeStr(line) && /^ {0,3}(?:=+|-+) *$/.test(U)) {
            text += '\n' + '    ' + Z.replace(/^ {0,3}/, '');
          } else {
            text += '\n' + U;
          }
        }
        blank = U.trim() === '';
        e = eol < n ? eol + 1 : n;
        line = Z.slice(R);
      }
    }
    const raw = src.slice(itemStart, e);
    if (!list.loose) {
      if (prevBlank) list.loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(raw)) prevBlank = true;
    }
    list.items.push({ type: 'list_item', raw, text, tokens: [], task: false, checked: false });
    pos = e;
  }
  if (list.items.length === 0) return null;
  const lastItem = list.items[list.items.length - 1];
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(p, pos).trimEnd();
  const st = doc.state;
  for (const item of list.items) {
    st.top = false;
    item.tokens = blockTokens(item.text, doc, false);
    if (!list.loose) {
      for (const t of item.tokens) {
        if (t.type === 'space' && /\n.*\n/.test(t.raw)) {
          list.loose = true;
          break;
        }
      }
    }
  }
  for (const item of list.items) {
    item.task = /^\[[ xX]\][ \t]+\S/.test(item.text);
    if (!item.task) continue;
    const d = item.tokens[0];
    if (!d || (d.type !== 'text' && d.type !== 'para')) {
      item.task = false;
      continue;
    }
    const m = /\[[ xX]\]/.exec(item.raw);
    if (!m) {
      item.task = false;
      continue;
    }
    item.checked = m[0] !== '[ ]';
    item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
    d.raw = (d.raw || '').replace(/^\[[ xX]\][ \t]+/, '');
    d.text = d.text.replace(/^\[[ xX]\][ \t]+/, '');
  }
  if (list.loose) {
    for (const item of list.items) for (const t of item.tokens) if (t.type === 'text') t.type = 'para';
  }
  return [p + list.raw.length, list];
}

// string-level variants used for the lazy-continuation checks
function isHrStr(s, max) {
  let j = 0;
  let sp = 0;
  while (j < s.length && sp < max + 1 && s.charCodeAt(j) === 32) {
    j++;
    sp++;
  }
  if (sp > max) return false;
  const ch = s.charCodeAt(j);
  if (ch !== 45 && ch !== 95 && ch !== 42) return false;
  let count = 0;
  for (; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

function indentWithin(s, max) {
  let sp = 0;
  while (sp < s.length && s.charCodeAt(sp) === 32 && sp <= max) sp++;
  return sp <= max;
}

function isHeadingStr(s, max) {
  if (!indentWithin(s, max)) return false;
  let j = 0;
  while (j < s.length && s.charCodeAt(j) === 32) j++;
  let k = 0;
  while (j < s.length && s.charCodeAt(j) === 35 && k < 7) {
    j++;
    k++;
  }
  if (k < 1 || k > 6) return false;
  if (j >= s.length) return true;
  const c = s.charCodeAt(j);
  return c === 32 || c === 9;
}

function isFenceStr(s, max) {
  if (!indentWithin(s, max)) return false;
  let j = 0;
  while (j < s.length && s.charCodeAt(j) === 32) j++;
  const ch = s.charCodeAt(j);
  if (ch !== 96 && ch !== 126) return false;
  let k = 0;
  while (j < s.length && s.charCodeAt(j) === ch) {
    j++;
    k++;
  }
  if (k < 3) return false;
  if (ch === 96) for (; j < s.length; j++) if (s.charCodeAt(j) === 96) return false;
  return true;
}

function isHtmlStr(s, max, single) {
  if (!indentWithin(s, max)) return false;
  let j = 0;
  while (j < s.length && s.charCodeAt(j) === 32) j++;
  const line = s.slice(j);
  const c1 = line.charCodeAt(1);
  if (c1 !== 47 && rawBlockName(line)) return true;
  if (c1 === 47) {
    const m = RE_TAG_NAME.exec(line);
    if (!m) return false;
    if (isBlockTagName(m[1]) && blockTagRest(line.slice(m[0].length))) return true;
    return !!single && RE_CLOSE_TAG_LINE.test(line);
  }
  if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
    const m = RE_TAG_NAME.exec(line);
    if (!m || m[0][1] === '/') return false;
    if (isBlockTagName(m[1]) && blockTagRest(line.slice(m[0].length))) return true;
    return !!single && RE_OPEN_TAG_LINE.test(line);
  }
  if (c1 === 33) return line.startsWith('<!--') || line.startsWith('<![CDATA[') || /^<![A-Za-z]/.test(line);
  if (c1 === 63) return true;
  return false;
}

function isHeadingLikeStr(s) {
  return (
    /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(s) ||
    /^(?: {4}| {0,3}\t)/.test(s) ||
    isFenceStr(s, 3) ||
    /^ {0,3}>/.test(s) ||
    isHeadingStr(s, 3)
  );
}

/* --------------------------------------------------------------------- html */

function htmlToken(raw) {
  const text = trimBlankTail(raw);
  return { type: 'html', raw: text, text };
}

function tryHtml(src, p) {
  const n = src.length;
  const eol = lineEnd(src, p);
  const sp = countSpaces(src, p, eol);
  if (sp > 3) return null;
  const line = src.slice(p + sp, eol);
  const c1 = line.charCodeAt(1);
  let kind = 0;
  if (rawBlockName(line)) kind = 1;
  if (!kind && line.startsWith('<!--')) kind = 2;
  if (!kind && line.startsWith('<?')) kind = 3;
  if (!kind && /^<![A-Z]/.test(line)) kind = 4;
  if (!kind && line.startsWith('<![CDATA[')) kind = 5;
  if (!kind && (c1 === 47 || (c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) {
    const m = RE_TAG_NAME.exec(line);
    if (!m) return null;
    const after = line.slice(m[0].length);
    if (isBlockTagName(m[1]) && blockTagRest(after)) kind = 6;
    else if (c1 === 47 && RE_CLOSE_TAG_LINE.test(line)) kind = 7;
    else if (c1 !== 47 && RE_OPEN_TAG_LINE.test(line)) kind = 7;
    else return null;
  }
  if (!kind) return null;
  if (kind === 1) {
    const name = rawBlockName(line);
    const re = new RegExp('</' + name + '>[^\\n]*', 'i');
    const body = src.slice(p + sp);
    const m = re.exec(body);
    if (!m) return [n, htmlToken(src.slice(p, n))];
    let end = p + sp + m.index + m[0].length;
    let q = end;
    while (q < n && src.charCodeAt(q) === 10) q++;
    return [q, htmlToken(src.slice(p, q))];
  }
  if (kind >= 2 && kind <= 5) {
    const start = p + sp;
    let term = -1;
    let termLen = 0;
    if (kind === 2) {
      if (src.startsWith('<!-->', start)) {
        term = start + 5;
        termLen = 5;
      } else {
        const i2 = src.indexOf('-->', start + 4);
        if (i2 >= 0) {
          term = i2 + 3;
          termLen = 3;
        }
      }
    } else if (kind === 3) {
      const i2 = src.indexOf('?>', start + 2);
      if (i2 >= 0) {
        term = i2 + 2;
        termLen = 2;
      }
    } else if (kind === 4) {
      const i2 = src.indexOf('>', start + 2);
      if (i2 >= 0) {
        term = i2 + 1;
        termLen = 1;
      }
    } else {
      const i2 = src.indexOf(']]>', start + 9);
      if (i2 >= 0) {
        term = i2 + 3;
        termLen = 3;
      }
    }
    if (term < 0) return [n, htmlToken(src.slice(p, n))];
    let q = term;
    while (q < n && src.charCodeAt(q) !== 10) q++;
    while (q < n && src.charCodeAt(q) === 10) q++;
    return [q, htmlToken(src.slice(p, q))];
  }
  let q = eol < n ? eol + 1 : n;
  for (;;) {
    if (q >= n) return [n, htmlToken(src.slice(p, n))];
    const le = lineEnd(src, q);
    if (isBlankStr(src.slice(q, le))) {
      let r = q;
      while (r < n) {
        const le2 = lineEnd(src, r);
        if (!isBlankStr(src.slice(r, le2))) break;
        r = le2 < n ? le2 + 1 : n;
      }
      return [r, htmlToken(src.slice(p, r))];
    }
    q = le < n ? le + 1 : n;
  }
}

/* --------------------------------------------------- link reference defs */

function tryDef(src, p) {
  const n = src.length;
  const eol = lineEnd(src, p);
  const sp = countSpaces(src, p, eol);
  if (sp > 3) return null;
  let j = p + sp;
  if (j >= eol || src.charCodeAt(j) !== 91) return null;
  let k = j + 1;
  {
    let t = k;
    while (t < n && isSpaceChar(src[t])) t++;
    if (t < n && src.charCodeAt(t) === 93) return null;
  }
  let label = '';
  let q = k;
  for (;;) {
    if (q >= n) return null;
    const c = src.charCodeAt(q);
    if (c === 92) {
      if (q + 1 >= n) return null;
      label += src.slice(q, q + 2);
      q += 2;
      continue;
    }
    if (c === 93) break;
    if (c === 91) return null;
    if (c === 10) {
      const le = lineEnd(src, q + 1);
      if (isBlankStr(src.slice(q + 1, le))) return null;
      label += '\n';
      q++;
      continue;
    }
    label += src[q];
    q++;
  }
  if (q + 1 >= n || src.charCodeAt(q + 1) !== 58) return null;
  q += 2;
  while (q < n && src.charCodeAt(q) === 32) q++;
  if (q < n && src.charCodeAt(q) === 10) {
    q++;
    while (q < n && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
  }
  let dest;
  if (q < n && src.charCodeAt(q) === 60) {
    const close = src.indexOf('>', q);
    if (close < 0) return null;
    dest = src.slice(q, close + 1);
    q = close + 1;
  } else {
    const st = q;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c === 32 || c === 9 || c === 10) break;
      q++;
    }
    if (q === st) return null;
    dest = src.slice(st, q);
  }
  let title;
  {
    // whitespace before a title: ` +(\n[ \t]*)?` or ` *\n[ \t]*`
    let t = q;
    let sawSpaces = false;
    while (t < n && src.charCodeAt(t) === 32) {
      t++;
      sawSpaces = true;
    }
    let sawNewline = false;
    if (t < n && src.charCodeAt(t) === 10) {
      t++;
      while (t < n && (src.charCodeAt(t) === 32 || src.charCodeAt(t) === 9)) t++;
      sawNewline = true;
    }
    if ((sawSpaces || sawNewline) && t < n && (src.charCodeAt(t) === 34 || src.charCodeAt(t) === 39 || src.charCodeAt(t) === 40)) {
      const open = src.charCodeAt(t);
      const closeCh = open === 40 ? 41 : open;
      let u = t + 1;
      let val = '';
      let ok = false;
      while (u < n) {
        const c = src.charCodeAt(u);
        if (c === 92) {
          if (u + 1 >= n) break;
          val += src.slice(u, u + 2);
          u += 2;
          continue;
        }
        if (c === closeCh) {
          ok = true;
          break;
        }
        if (c === 10) {
          if (open === 40) break;
          if (open === 39 && u + 1 < n && src.charCodeAt(u + 1) === 10) break;
          val += '\n';
          u++;
          continue;
        }
        val += src[u];
        u++;
      }
      if (ok) {
        // tail after the title: ` *(?:\n+|$)`
        let tail = u + 1;
        while (tail < n && src.charCodeAt(tail) === 32) tail++;
        let tailEnd = -1;
        if (tail >= n) tailEnd = n;
        else if (src.charCodeAt(tail) === 10) {
          tailEnd = tail;
          while (tailEnd < n && src.charCodeAt(tailEnd) === 10) tailEnd++;
        }
        if (tailEnd >= 0) {
          title = val;
          q = tailEnd;
        }
      }
    }
  }
  if (title === undefined) {
    // tail without a title: ` *(?:\n+|$)`
    let tail = q;
    while (tail < n && src.charCodeAt(tail) === 32) tail++;
    if (tail >= n) q = n;
    else if (src.charCodeAt(tail) === 10) {
      q = tail;
      while (q < n && src.charCodeAt(q) === 10) q++;
    } else return null;
  }
  if (!dest) return null;
  if (dest.charCodeAt(0) !== 60 && unbalancedParens(dest)) return null;
  let href = dest;
  if (href.startsWith('<')) href = href.slice(1, -1);
  href = unescapeBackslashPunct(href);
  const tag = labelKey(label);
  const raw = rtrimChar(src.slice(p, q), '\n');
  return [p + raw.length, { type: 'def', tag, href, title: title === undefined ? undefined : unescapeBackslashPunct(title), raw }];
}

function unbalancedParens(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) i++;
    else if (c === 40) depth++;
    else if (c === 41) {
      depth--;
      if (depth < 0) return true;
    }
  }
  return depth > 0;
}

/* ------------------------------------------------------------------- tables */

function splitRow(row, headerCount) {
  // marked's de(): split on unescaped pipes, trim the outer empties, pad/truncate
  const cells = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const c = row.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < row.length) {
        cur += row[i] + row[i + 1];
        i++;
      } else cur += row[i];
      continue;
    }
    if (c === 124) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += row[i];
  }
  cells.push(cur);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (headerCount) {
    if (cells.length > headerCount) cells.length = headerCount;
    else while (cells.length < headerCount) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

function tryTable(src, p) {
  const n = src.length;
  const eol = lineEnd(src, p);
  if (eol >= n) return null;
  if (src.charCodeAt(p) === 32) return null;
  const headerLine = src.slice(p, eol);
  if (headerLine.length === 0) return null;
  const delimEol = lineEnd(src, eol + 1);
  const delimLine = src.slice(eol + 1, delimEol);
  const delimTrim = delimLine.trim();
  if (!delimTrim) return null;
  if (!/[:|]/.test(delimTrim)) return null;
  if (!isTableDelimLine(src, eol + 1, 3, delimEol)) return null;
  let q = delimEol < n ? delimEol + 1 : n;
  const rows = [];
  let rawEnd = q;
  while (q < n) {
    const le = lineEnd(src, q);
    if (/^ *$/.test(src.slice(q, le))) break;
    if (startsBlock(src, q, n)) break;
    if (isTableDelimLine(src, q, 3, le)) break;
    let sp = 0;
    while (q + sp < le && sp < 4 && src.charCodeAt(q + sp) === 32) sp++;
    const indented =
      (sp === 4 && q + sp < le) ||
      (sp < 4 && q + sp < le && src.charCodeAt(q + sp) === 9 && q + sp + 1 < le);
    if (indented) break;
    rows.push(splitRow(src.slice(q, le), 0));
    q = le < n ? le + 1 : n;
    rawEnd = q;
  }
  const header = splitRow(headerLine, 0);
  const alignSrc = delimTrim.replace(/^\||\| *$/g, '').split('|');
  if (header.length !== alignSrc.length) return null;
  const align = alignSrc.map((a) => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  const body = [];
  for (const r of rows) {
    const cells = r.slice();
    if (cells.length > header.length) cells.length = header.length;
    else while (cells.length < header.length) cells.push('');
    body.push(cells);
  }
  const raw = rtrimChar(src.slice(p, rawEnd), '\n');
  return [p + raw.length, { type: 'table', raw, header, align, rows: body }];
}

/* ------------------------------------------------------- setext + paras */

function tryLheading(src, p) {
  const n = src.length;
  const firstEol = lineEnd(src, p);
  if (firstEol >= n) return null;
  const firstLine = src.slice(p, firstEol);
  if (isHeadingLikeStr(firstLine)) return null;
  if (isTableDelimLine(src, p, 0, firstEol)) return null;
  let q = p;
  let textEnd = p;
  for (;;) {
    const le = lineEnd(src, q);
    if (q > p) {
      const line = src.slice(q, le);
      if (isBlankStr(line)) return null;
      if (startsBlock(src, q, n)) return null;
      if (isTableDelimLine(src, q, 3, le)) return null;
    }
    textEnd = le;
    if (le >= n) return null;
    const nextEol = lineEnd(src, le + 1);
    const nextLine = src.slice(le + 1, nextEol);
    const sp = countSpaces(nextLine, 0, nextLine.length);
    if (sp <= 3) {
      const body = nextLine.slice(sp);
      let d = 0;
      let ch = 0;
      while (d < body.length && body.charCodeAt(d) === 61) {
        d++;
        ch = 1;
      }
      if (d === 0) {
        d = 0;
        while (d < body.length && body.charCodeAt(d) === 45) {
          d++;
          ch = 2;
        }
      }
      if (d > 0) {
        let k = d;
        while (k < body.length && (body.charCodeAt(k) === 32 || body.charCodeAt(k) === 9)) k++;
        if (k === body.length) {
          const text = src.slice(p, textEnd).trim();
          const raw = src.slice(p, nextEol);
          return [p + raw.length, { type: 'heading', depth: ch, text, raw }];
        }
      }
    }
    q = le + 1;
  }
}

function tryParagraph(src, p) {
  const n = src.length;
  let q = lineEnd(src, p);
  for (;;) {
    if (q >= n) break;
    const next = q + 1;
    if (next >= n) break;
    const le = lineEnd(src, next);
    const line = src.slice(next, le);
    if (line.length === 0) break;
    if (le < n && isBlankStr(line)) break;
    if (startsBlock(src, next, n)) break;
    if (startsTable(src, next, n)) break;
    q = le;
  }
  const text = src.slice(p, q);
  return [q, { type: 'para', text, raw: text }];
}

/* -------------------------------------------------------------- block loop */

export function blockTokens(src, doc, top) {
  const out = [];
  blockTokensInto(src, out, false, doc, top);
  return out;
}

function blockTokensInto(src, out, lazy, doc, topArg) {
  const n = src.length;
  const st = doc.state;
  if (topArg !== undefined) st.top = topArg;
  let p = 0;
  while (p < n) {
    let r;
    if ((r = trySpace(src, p))) {
      p = r[0];
      const prev = out[out.length - 1];
      if (r[1].raw.length === 1 && prev !== undefined) prev.raw = (prev.raw || '') + '\n';
      else out.push(r[1]);
      continue;
    }
    if ((r = tryCode(src, p))) {
      p = r[0];
      const prev = out[out.length - 1];
      if (prev && (prev.type === 'para' || prev.type === 'text')) {
        prev.text += '\n' + r[1].text;
      } else out.push(r[1]);
      continue;
    }
    if ((r = tryFences(src, p))) {
      p = r[0];
      out.push(r[1]);
      continue;
    }
    if ((r = tryHeading(src, p))) {
      p = r[0];
      out.push(r[1]);
      continue;
    }
    if ((r = tryHr(src, p))) {
      p = r[0];
      out.push(r[1]);
      continue;
    }
    if ((r = tryBlockquote(src, p, doc))) {
      p = r[0];
      out.push(r[1]);
      continue;
    }
    if ((r = tryList(src, p, doc))) {
      p = r[0];
      out.push(r[1]);
      continue;
    }
    if ((r = tryHtml(src, p))) {
      p = r[0];
      out.push(r[1]);
      continue;
    }
    if ((r = tryDef(src, p))) {
      p = r[0];
      const prev = out[out.length - 1];
      if (prev && (prev.type === 'para' || prev.type === 'text')) {
        prev.text += '\n' + r[1].raw;
      } else {
        if (!doc.links[r[1].tag]) doc.links[r[1].tag] = { href: r[1].href, title: r[1].title };
        out.push(r[1]);
      }
      continue;
    }
    if ((r = tryTable(src, p))) {
      p = r[0];
      out.push(r[1]);
      continue;
    }
    if ((r = tryLheading(src, p))) {
      p = r[0];
      out.push(r[1]);
      continue;
    }
    if (st.top) {
      const before = p;
      r = tryParagraph(src, p);
      p = r[0];
      const prev = out[out.length - 1];
      if (lazy && prev && prev.type === 'para') prev.text += '\n' + r[1].text;
      else out.push(r[1]);
      lazy = p !== before;
      continue;
    }
    r = tryText(src, p);
    if (r[0] <= p) throw FALLBACK;
    p = r[0];
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text') prev.text += '\n' + r[1].text;
    else out.push(r[1]);
    if (st.top === undefined) throw FALLBACK;
  }
  st.top = true;
  return out;
}

function tryText(src, p) {
  const eol = lineEnd(src, p);
  return [eol, { type: 'text', text: src.slice(p, eol), raw: src.slice(p, eol) }];
}

/* ---------------------------------------------------------------- rendering */

function renderTokens(tokens, doc) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + t.depth + '>' + inline(t.text, doc) + '</h' + t.depth + '>\n';
        break;
      case 'code':
        out += renderCode(t.text.replace(/\n$/, '') + '\n', '');
        break;
      case 'fence':
        out += renderCode(t.text ? t.text.replace(/\n$/, '') + '\n' : '', t.lang);
        break;
      case 'html':
        out += t.text;
        break;
      case 'para':
        out += '<p>' + inline(t.text, doc) + '</p>\n';
        break;
      case 'text':
        out += inline(t.text, doc);
        break;
      case 'quote':
        out += '<blockquote>\n' + renderTokens(t.tokens, doc) + '</blockquote>\n';
        break;
      case 'table':
        out += renderTable(t, doc);
        break;
      case 'list':
        out += renderList(t, doc);
        break;
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'list_item':
        out += renderTokens(t.tokens, doc);
        break;
      default:
        throw FALLBACK;
    }
  }
  return out;
}

function renderCode(text, lang) {
  const first = lang ? /^\S*/.exec(lang)[0] : '';
  return first
    ? '<pre><code class="language-' + esc(first) + '">' + esc(text, true) + '</code></pre>\n'
    : '<pre><code>' + esc(text, true) + '</code></pre>\n';
}

function renderTable(t, doc) {
  let head = '';
  for (let i = 0; i < t.header.length; i++) {
    const align = t.align[i];
    head += (align ? '<th align="' + align + '">' : '<th>') + inline(t.header[i], doc) + '</th>\n';
  }
  let body = '';
  for (let r = 0; r < t.rows.length; r++) {
    const row = t.rows[r];
    let cells = '';
    for (let c = 0; c < row.length; c++) {
      const align = t.align[c];
      cells += (align ? '<td align="' + align + '">' : '<td>') + inline(row[c], doc) + '</td>\n';
    }
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
}

function checkboxHtml(task) {
  return '<input ' + (task.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderList(list, doc) {
  const st = doc.state;
  const savedTop = st.top;
  let items = '';
  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i];
    let inner;
    if (item.task) {
      // marked puts the checkbox before the item's first inline tokens
      let rendered = '';
      const toks = item.tokens;
      for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (k === 0 && (t.type === 'para' || t.type === 'text')) {
          if (t.type === 'para') {
            rendered += '<p>' + checkboxHtml(item) + inline(t.text, doc) + '</p>\n';
          } else {
            rendered += checkboxHtml(item) + inline(t.text, doc);
          }
        } else if (k === 0) {
          rendered += '<p>' + checkboxHtml(item) + '</p>\n';
        } else {
          rendered += renderTokens([t], doc);
        }
      }
      if (toks.length === 0) rendered = '<p>' + checkboxHtml(item) + '</p>\n';
      inner = rendered;
    } else {
      inner = renderTokens(item.tokens, doc);
    }
    items += '<li>' + inner + '</li>\n';
  }
  st.top = savedTop;
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ' start="' + list.start + '"' : '';
  return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
}

/* ------------------------------------------------------------------- inline */

const RE_ANY_PUNCT_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RE_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const RE_REF_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;

const RE_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const RE_REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const RE_NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const RE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const RE_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const RE_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_CODE_IN_TEXT = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_EM_AST =
  /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RE_EM_UND =
  /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RE_DEL_R =
  /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

const EMAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]/;
const ESCAPABLE = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ESCAPABLE[ch.charCodeAt(0)] = 1;
const STOP_TEXT = new Uint8Array(128);
for (const ch of '\\<![`*~_') STOP_TEXT[ch.charCodeAt(0)] = 1;

function maskSource(src, doc) {
  let t = src;
  if (doc.links && src.includes('[') && hasLinks(doc)) {
    t = t.replace(RE_REF_SEARCH, (m) => maskRef(m, doc));
  }
  t = t.replace(RE_ANY_PUNCT_CODE, (m, s, r) =>
    r ? '+'.repeat(m.length) : s ? s + m.slice(s.length, -s.length).replace(/`/g, '+') + s : m,
  );
  t = t.replace(RE_BLOCK_SKIP, (m, s, r) => {
    const o = r ? r.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
  });
  return t;
}

function hasLinks(doc) {
  for (const k in doc.links) return true;
  return false;
}

function maskRef(m, doc) {
  const o = m.lastIndexOf('[');
  if (!doc.links[labelKey(m.slice(o + 1, -1))]) return m;
  if (o > 1 && m.charAt(0) !== '!') {
    const inner = m.slice(1, o - 1);
    if (linkInText(inner, doc)) {
      return '[' + inner.replace(RE_REF_SEARCH, (mm) => maskRef(mm, doc)) + '][' + 'a'.repeat(m.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(m.length - 2) + ']';
}

function linkInText(s, doc) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(RE_BLOCK_SKIP)) {
    if (RE_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(RE_REF_SEARCH)) {
    const str = m[0];
    const r = str.lastIndexOf('[');
    const hasDef = Object.hasOwn(doc.links, labelKey(str.slice(r + 1, -1)));
    if (!(str.charAt(0) === '!' || !hasDef) && !(r > 1 && linkInText(str.slice(1, r - 1), doc))) return true;
  }
  return false;
}

function lastDelimIndex(masked, ch) {
  let last = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    if (masked[i] !== ch) continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (!isSpaceChar(prev)) last = i;
    i = j - 1;
  }
  return last;
}

function inline(src, doc) {
  doc.state.inRawBlock = false;
  return inlineTo(src, doc, false);
}

function inlineTo(src, doc, plain) {
  const st = doc.state;
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  try {
    return inlineCore(src, doc, plain);
  } finally {
    st.linkParenPossible = savedParen;
  }
}

function inlineCore(src, doc, plain) {
  const n = src.length;
  const state = doc.state;
  let out = '';
  let i = 0;
  let lastChar = '';
  let masked = null;
  let lasts = null;
  const mask = () => {
    if (masked === null) {
      masked = maskSource(src, doc);
      lasts = { '*': -2, _: -2, '~': -2 };
    }
    return masked;
  };
  const lastOf = (ch) => {
    mask();
    if (lasts[ch] === -2) lasts[ch] = lastDelimIndex(masked, ch);
    return lasts[ch];
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      const next = src[i + 1];
      if (ESCAPABLE[next.charCodeAt(0)]) {
        out += plain ? next : esc(next);
        i += 2;
        lastChar = '';
        continue;
      }
    }
    if (c === 60) {
      const rest = src.slice(i);
      const m = RE_TAG.exec(rest);
      if (m) {
        const tok = m[0];
        if (!state.inLink && /^<a /i.test(tok)) state.inLink = true;
        else if (state.inLink && /^<\/a>/i.test(tok)) state.inLink = false;
        if (!state.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tok)) state.inRawBlock = true;
        else if (state.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tok)) state.inRawBlock = false;
        out += tok;
        i += tok.length;
        lastChar = '';
        continue;
      }
    }
    if (c === 91 || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91)) {
      const rest = src.slice(i);
      const m = RE_LINK.exec(rest);
      if (m) {
        const built = buildLink(m, rest, doc, plain);
        if (built) {
          out += built.html;
          i += built.len;
          lastChar = '';
          continue;
        }
      }
      const m2 = RE_REFLINK.exec(rest) || RE_NOLINK.exec(rest);
      if (m2) {
        const built = buildRefLink(m2, rest, doc, plain);
        if (built) {
          out += built.html;
          i += built.len;
          lastChar = '';
          continue;
        }
        const first = rest.charCodeAt(0) === 33 ? '!' : '[';
        out += plain ? first : first;
        i += 1;
        lastChar = '';
        continue;
      }
    }
    if (c === 42 || c === 95) {
      const r = tryEmStrong(src, i, doc, plain, lastChar, mask, lastOf);
      if (r) {
        out += r.html;
        i += r.len;
        lastChar = '';
        continue;
      }
    }
    if (c === 96) {
      const r = tryCodespan(src, i);
      if (r) {
        out += plain ? r.text : '<code>' + esc(r.text, true) + '</code>';
        i += r.len;
        lastChar = '';
        continue;
      }
    }
    if (c === 10 || c === 32 || c === 92) {
      const m = RE_BR.exec(src.slice(i));
      if (m) {
        out += plain ? '' : '<br>';
        i += m[0].length;
        lastChar = '';
        continue;
      }
    }
    if (c === 126) {
      const r = tryDel(src, i, doc, plain, lastChar, mask, lastOf);
      if (r) {
        out += r.html;
        i += r.len;
        lastChar = '';
        continue;
      }
    }
    if (c === 60) {
      const m = RE_AUTOLINK.exec(src.slice(i));
      if (m) {
        const text = m[1];
        const href = m[2] === '@' ? 'mailto:' + text : text;
        if (plain) out += text;
        else {
          const enc = encodeHref(href);
          out += enc === null ? esc(text, true) : '<a href="' + esc(enc, true) + '">' + esc(text, true) + '</a>';
        }
        i += m[0].length;
        lastChar = '';
        continue;
      }
    }
    if (!state.inLink) {
      const m = RE_URL.exec(src.slice(i));
      if (m) {
        const r = urlToken(m, plain);
        out += r.html;
        i += r.len;
        lastChar = '';
        continue;
      }
    }
    const len = scanInlineText(src, i);
    if (len <= 0) throw FALLBACK;
    const raw = src.slice(i, i + len);
    if (plain) {
      out += state.inRawBlock ? raw : unescapeEntities(raw);
    } else {
      let text = raw;
      if (!state.inRawBlock) text = unescapeEntities(text);
      out += esc(text);
    }
    i += len;
    lastChar = raw.charCodeAt(raw.length - 1) === 95 ? '' : raw[raw.length - 1];
  }
  return out;
}

function urlToken(m, plain) {
  if (m[2] === '@') {
    const text = m[0];
    const href = 'mailto:' + text;
    if (plain) return { html: text, len: text.length };
    const enc = encodeHref(href);
    return {
      html: enc === null ? esc(text, true) : '<a href="' + esc(enc, true) + '">' + esc(text, true) + '</a>',
      len: text.length,
    };
  }
  let text = m[0];
  for (;;) {
    const b = RE_BACKPEDAL.exec(text);
    const next = b ? b[0] : '';
    if (next === text) break;
    text = next;
  }
  const href = m[1] === 'www.' ? 'http://' + text : text;
  if (plain) return { html: text, len: text.length };
  const enc = encodeHref(href);
  if (enc === null) return { html: esc(text, true), len: text.length };
  return {
    html: '<a href="' + esc(enc, true) + '">' + esc(text, true) + '</a>',
    len: text.length,
  };
}

function hasAngleOverrun(rest, textRaw, skip) {
  if (!textRaw.includes('<')) return false;
  for (let s = 0; s < textRaw.length; s++) {
    if (textRaw[s] === '\\') {
      s++;
      continue;
    }
    if (textRaw[s] === '`') {
      const m = RE_CODE_IN_TEXT.exec(textRaw.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (textRaw[s] !== '<') continue;
    const r = rest.slice(skip + s);
    const m = RE_TAG.exec(r) || RE_AUTOLINK.exec(r);
    if (m) {
      if (m[0].length > textRaw.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

function parenBalance(s) {
  if (!s.includes('(') && !s.includes(')')) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

function buildLink(m, rest, doc, plain) {
  const isImage = rest.charCodeAt(0) === 33;
  const textRaw = m[1];
  if (hasAngleOverrun(rest, textRaw, isImage ? 2 : 1)) return null;
  let dest = m[2].trim();
  let raw = m[0];
  let title = m[3] || '';
  if (dest.startsWith('<')) {
    if (!dest.endsWith('>')) return null;
    const stripped = rtrimChar(dest.slice(0, -1), '\\');
    if ((dest.length - stripped.length) % 2 === 0) return null;
  } else {
    const k = parenBalance(m[2]);
    if (k === -2) return null;
    if (k > -1) {
      const cut = (isImage ? 5 : 4) + textRaw.length + k;
      raw = raw.substring(0, cut).trim();
      m[2] = m[2].substring(0, k);
      title = '';
      dest = m[2].trim();
    }
  }
  const beforeLast = raw.slice(0, -1);
  const strippedRaw = rtrimChar(beforeLast, '\\');
  if ((raw.length - strippedRaw.length) % 2 === 0) return null;
  let href = dest.trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  const titleText = title ? title.slice(1, -1) : '';
  return finishLink(
    isImage,
    textRaw.replace(/\\([\[\]])/g, '$1'),
    unescapeBackslashPunct(href),
    titleText ? unescapeBackslashPunct(titleText) : undefined,
    raw.length,
    doc,
    plain,
  );
}

function buildRefLink(m, rest, doc, plain) {
  const isImage = rest.charCodeAt(0) === 33;
  const textRaw = m[1];
  if (!isImage && hasAngleOverrun(rest, textRaw, 1)) return null;
  const label = m[2] || m[1];
  const def = doc.links[labelKey(label)];
  if (!def) return null;
  return finishLink(
    isImage,
    textRaw.replace(/\\([\[\]])/g, '$1'),
    def.href,
    def.title,
    m[0].length,
    doc,
    plain,
  );
}

function finishLink(isImage, text, href, title, len, doc, plain) {
  const state = doc.state;
  const savedInLink = state.inLink;
  const savedEmitted = doc.linkEmitted;
  const savedRaw = state.inRawBlock;
  state.inLink = true;
  doc.linkEmitted = false;
  const inner = inlineTo(text, doc, plain || isImage);
  const emitted = doc.linkEmitted;
  doc.linkEmitted = savedEmitted;
  state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      state.inRawBlock = savedRaw;
      return null;
    }
    doc.linkEmitted = true;
  }
  if (isImage) {
    const enc = encodeHref(href);
    if (enc === null) return { html: plain ? inner : esc(inner), len };
    if (plain) return { html: inner, len };
    let out = '<img src="' + esc(enc) + '" alt="' + esc(inner) + '"';
    if (title) out += ' title="' + esc(title) + '"';
    return { html: out + '>', len };
  }
  if (plain) return { html: inner, len };
  const enc = encodeHref(href);
  if (enc === null) return { html: inner, len };
  let out = '<a href="' + esc(enc) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return { html: out + '>' + inner + '</a>', len };
}

function tryCodespan(src, i) {
  const n = src.length;
  let k = 0;
  while (i + k < n && src.charCodeAt(i + k) === 96) k++;
  const start = i + k;
  if (start >= n) return null;
  if (src.charCodeAt(start) === 96) return null;
  let j = start;
  while (j < n) {
    if (src.charCodeAt(j) === 96) {
      let run = 0;
      while (j + run < n && src.charCodeAt(j + run) === 96) run++;
      if (run === k) {
        let text = src.slice(start, j).replace(/\n/g, ' ');
        const hasNonSpace = /[^ ]/.test(text);
        if (hasNonSpace && text.startsWith(' ') && text.endsWith(' '))
          text = text.substring(1, text.length - 1);
        return { text, len: j + k - i };
      }
      j += run;
      continue;
    }
    j++;
  }
  return null;
}

function tryEmStrong(src, i, doc, plain, lastChar, mask, lastOf) {
  const c = src.charCodeAt(i);
  const ch = c === 42 ? '*' : '_';
  const masked = mask();
  if (masked[i] !== ch) return null;
  let k = 0;
  while (i + k < src.length && src.charCodeAt(i + k) === c) k++;
  let s1 = '';
  let s2 = '';
  let s3 = '';
  let s4 = '';
  if (i + k < src.length) {
    const nc = src[i + k];
    if (ch === '*') {
      if (isPunctChar(nc) && nc !== '~') s1 = nc;
      else if (!isSpaceChar(nc)) s2 = nc;
    } else {
      if (isPunctChar(nc) && nc !== '~') s3 = nc;
      else if (!isSpaceChar(nc)) s4 = nc;
    }
  }
  if (!s1 && !s2 && !s3 && !s4) return null;
  const g1 = s1 || s3;
  const o = lastChar === ch;
  let l = i;
  while (l > 0 && masked[l - 1] === ch) l--;
  const pChar = l - 1 >= 0 ? masked[l - 1] : '';
  const h = pChar === '*' || pChar === '_' || (pChar !== '' && isPunctOrSpace(pChar));
  let n = lastChar;
  if (l < i) n = pChar;
  const u = l < i ? h : n !== '' && isPunctOrSpace(n);
  if (s4 && n !== '' && isAlnumChar(n)) return null;
  const d = g1;
  if (!d || !n || u) {
    let m = k;
    let f = 0;
    const y = i - l + k;
    const R = pChar.trim() !== '' && (!!d || (ch === '*' && !h));
    const A = ch === '*' ? RE_EM_AST : RE_EM_UND;
    const v = lastOf(ch);
    const Q = i + k;
    if (v < Q) return null;
    const t2 = masked.slice(i + k);
    const ee = v - Q;
    A.lastIndex = 0;
    let s;
    while ((s = A.exec(t2)) !== null && !(s.index > ee)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let b = g.length;
      if (s[3] || s[4]) {
        m += b;
        continue;
      } else if (s[5] || s[6] || R) {
        if (o && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = s[0].codePointAt(0) > 0xffff ? 2 : 1;
      const M = src.slice(i, i + k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const body = inlineTo(M.slice(1, -1), doc, plain);
        return { html: plain ? body : '<em>' + body + '</em>', len: M.length };
      }
      const body = inlineTo(M.slice(2, -2), doc, plain);
      return { html: plain ? body : '<strong>' + body + '</strong>', len: M.length };
    }
  }
  return null;
}

function tryDel(src, i, doc, plain, lastChar, mask, lastOf) {
  const masked = mask();
  if (masked[i] !== '~') return null;
  let k = 0;
  while (i + k < src.length && src.charCodeAt(i + k) === 126) k++;
  if (k > 2) return null;
  let g1 = '';
  if (i + k < src.length) {
    const nc = src[i + k];
    if (!isSpaceChar(nc) && nc !== '~') {
      if (isPunctChar(nc)) g1 = nc;
    }
  }
  if (!g1 || !lastChar || isPunctOrSpace(lastChar)) {
    const o = k;
    let p = o;
    const v = lastOf('~');
    const d = i + o;
    if (v < d) return null;
    const t2 = masked.slice(i + o);
    const kk = v - d;
    RE_DEL_R.lastIndex = 0;
    let s;
    while ((s = RE_DEL_R.exec(t2)) !== null && !(s.index > kk)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let l = g.length;
      if (l !== o) continue;
      if (s[3] || s[4]) {
        p += l;
        continue;
      }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const te = s[0].codePointAt(0) > 0xffff ? 2 : 1;
      const b = src.slice(i, i + o + s.index + te + l);
      const body = inlineTo(b.slice(o, -o), doc, plain);
      return { html: plain ? body : '<del>' + body + '</del>', len: b.length };
    }
  }
  return null;
}

function scanInlineText(src, i) {
  const n = src.length;
  const c0 = src.charCodeAt(i);
  if (c0 === 96 || c0 === 126) {
    let k = 1;
    while (i + k < n && src.charCodeAt(i + k) === c0) k++;
    if (i + k < n) {
      const nc = src.charCodeAt(i + k);
      if (nc === 96 || nc === 126) return k;
    }
    return k + scanTextRun(src, i + k, n);
  }
  if (!isAsciiAlnum(c0)) {
    const rest = src.slice(i + 1, i + 8);
    if (rest.startsWith('mailto:') || rest.startsWith('xmpp:')) return 1;
  }
  return 1 + scanTextRun(src, i + 1, n);
}

function isAsciiAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function scanTextRun(src, from, n) {
  // zero-width alternatives tried right after the run's first character
  let sp = from;
  while (sp < n && src.charCodeAt(sp) === 32) sp++;
  if (sp - from >= 2 && sp < n && src.charCodeAt(sp) === 10) return 0;
  let em = from;
  while (em < n && EMAIL_LOCAL.test(src[em])) em++;
  if (em > from && em < n && src.charCodeAt(em) === 64) return 0;
  let j = from;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c < 128) {
      if (STOP_TEXT[c]) break;
      if ((c === 104 || c === 72) && startsWithCI(src, j, 'http')) break;
      if ((c === 102 || c === 70) && startsWithCI(src, j, 'ftp://')) break;
      if (c === 119 || c === 87) {
        if (startsWithCI(src, j, 'www.')) {
          const prev = j === 0 ? '' : src[j - 1];
          if (j === 0 || prev === '*' || prev === '_' || prev === '~' || prev === '(' || /\s/.test(prev)) break;
        }
      }
    }
    if (c !== 32) {
      let m = j + 1;
      while (m < n && src.charCodeAt(m) === 32) m++;
      if (m - j - 1 >= 2 && m < n && src.charCodeAt(m) === 10) return j - from + 1;
    }
    if (!EMAIL_LOCAL.test(src[j])) {
      let m2 = j + 1;
      while (m2 < n && EMAIL_LOCAL.test(src[m2])) m2++;
      if (m2 > j + 1 && m2 < n && src.charCodeAt(m2) === 64) return j - from + 1;
      const rest = src.slice(j + 1, j + 8);
      if (rest.startsWith('mailto:') || rest.startsWith('xmpp:')) return j - from + 1;
    } else {
      let m2 = j;
      while (m2 < n && EMAIL_LOCAL.test(src[m2])) m2++;
      if (m2 < n && src.charCodeAt(m2) === 64) break;
    }
    j++;
  }
  return j - from;
}

function startsWithCI(src, j, word) {
  if (j + word.length > src.length) return false;
  for (let k = 0; k < word.length; k++) {
    let a = src.charCodeAt(j + k);
    if (a >= 65 && a <= 90) a += 32;
    if (a !== word.charCodeAt(k)) return false;
  }
  return true;
}
