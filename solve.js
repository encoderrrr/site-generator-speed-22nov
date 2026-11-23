// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly what
// makefun-site's build returns, byte for byte, for every input. Written from
// the reference's README and code; no dependency, no network, no clock, no
// file access. Speed comes from compiling each template once into a flat
// instruction list rendered into a string array, cached slugs and long
// dates, a line-driven Markdown renderer with a fast inline path, and
// per-source cards computed once and reused.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- text

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MARK_RE = /\p{M}/gu;

function slugify(cx, text) {
  const hit = cx.slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = null;
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = plain[i];
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const result = out === '' ? 'untitled' : out;
  cx.slugCache.set(text, result);
  return result;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(cx, date) {
  let hit = cx.dateCache.get(date);
  if (hit === undefined) {
    const parts = date.split('-');
    hit = `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
    cx.dateCache.set(date, hit);
  }
  return hit;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  // The first line must be exactly '---'. The closing '---' is found
  // first: a source with no closing line is refused as not closed whatever
  // its front-matter lines hold. Only then are those lines read, and the
  // body is the text after the closing line, so the body is never split.
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  let closeStart = -1;
  let closeEnd = -1;
  let pos = 4;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(pos, lineEnd) === '---') {
      closeStart = pos;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = lineEnd + 1;
  }
  const data = {};
  const fmLines = closeStart === 4 ? [] : text.slice(4, closeStart - 1).split('\n');
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (BLANK_RE.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const SPECIAL_RE = /[\\`*\[]/;
const WS_RE = /\s/;

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

// A line of only spaces and tabs (or empty); most lines fail on the first
// character, so the regex only runs for lines that start blank.
function isBlank(line) {
  const c = line.charCodeAt(0);
  return line.length === 0 || ((c === 32 || c === 9) && BLANK_RE.test(line));
}

function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR_RE.test(line);
  return false;
}

// The backslash-escapable characters, by code unit.
function isEscapable(code) {
  return code === 92 || code === 96 || code === 42 || code === 95 || code === 91 || code === 93 ||
    code === 40 || code === 41 || code === 35 || code === 43 || code === 45 || code === 46 ||
    code === 33 || code === 62;
}

function findUnescaped(s, what, from, end) {
  const wl = what.length;
  for (let j = from; j + wl <= end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function inlineRange(s, env, out, from, end) {
  let i = from;
  while (i < end) {
    // The next inline mark, found with native scans; the plain stretch
    // before it is escaped whole instead of one character at a time.
    let n1 = s.indexOf('\\', i);
    if (n1 === -1 || n1 >= end) n1 = Infinity;
    let n2 = s.indexOf('`', i);
    if (n2 === -1 || n2 >= end) n2 = Infinity;
    let n3 = s.indexOf('*', i);
    if (n3 === -1 || n3 >= end) n3 = Infinity;
    let n4 = s.indexOf('[', i);
    if (n4 === -1 || n4 >= end) n4 = Infinity;
    let next = n1 < n2 ? (n1 < n3 ? (n1 < n4 ? n1 : n4) : (n3 < n4 ? n3 : n4)) : (n2 < n3 ? (n2 < n4 ? n2 : n4) : (n3 < n4 ? n3 : n4));
    if (next === Infinity) {
      out.push(escapeHtml(s.slice(i, end)));
      return;
    }
    if (next > i) out.push(escapeHtml(s.slice(i, next)));
    const c = s.charCodeAt(next);
    i = next;
    if (c === 92) {
      if (i + 1 < end && isEscapable(s.charCodeAt(i + 1))) {
        const n = s.charCodeAt(i + 1);
        out.push(n === 62 ? '&gt;' : s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j > i + 1 && j < end) {
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          out.push('<strong>');
          inlineRange(s, env, out, i + 2, j);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        out.push('<em>');
        inlineRange(s, env, out, i + 1, j);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    const k = findUnescaped(s, ']', i + 1, end);
    let m = -1;
    if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
      const mm = s.indexOf(')', k + 2);
      if (mm !== -1 && mm < end) m = mm;
    }
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineRange(s, env, out, i + 1, k);
      out.push('</a>');
      i = m + 1;
      continue;
    }
    out.push('[');
    i++;
  }
}

function inline(s, env) {
  if (!SPECIAL_RE.test(s)) return escapeHtml(s);
  const out = [];
  inlineRange(s, env, out, 0, s.length);
  return out.join('');
}

function renderMarkdown(cx, src, env) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    const fence = c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      i++;
      let s = '<pre><code';
      if (fence[1] !== '') s += ` class="language-${escapeHtml(fence[1])}"`;
      s += '>';
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        s += escapeHtml(lines[i]);
        s += '\n';
        i++;
      }
      i++;
      s += '</code></pre>';
      blocks.push(s);
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(cx, heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR_RE.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        const stripped = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? BULLET_RE.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (lines[i].charCodeAt(0) === 32 && lines[i].charCodeAt(1) === 32 && CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      let s = isOrdered && start !== 1 ? `<ol start="${start}">\n` : isOrdered ? '<ol>\n' : '<ul>\n';
      for (let k = 0; k < items.length; k++) s += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      s += isOrdered ? '</ol>' : '</ul>';
      blocks.push(s);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const STAND_RE = /^[ \t]*$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = STAND_RE.test(src.slice(lineStart, open)) && STAND_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Ops: 0 text {s}, 1 var/raw {path, raw}, 2 if {not, path, then, els},
// 3 for {name, path, body}, 4 include {name}. `kind` is kept for parsing.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, s: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: 1, path: tok.path, raw: tok.t === 'raw' });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 3, kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 2, kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.els ?? parent.then);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 4, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderOps(ops, scope, templates, depth, out) {
  for (let n = 0; n < ops.length; n++) {
    const op = ops[n];
    if (op.k === 0) {
      out.push(op.s);
      continue;
    }
    if (op.k === 1) {
      const t = textOf(lookup(scope, op.path));
      out.push(op.raw ? t : escapeHtml(t));
      continue;
    }
    if (op.k === 2) {
      const branch = truthy(lookup(scope, op.path)) !== op.not ? op.then : op.els;
      if (branch !== null) renderOps(branch, scope, templates, depth, out);
      continue;
    }
    if (op.k === 3) {
      const xs = lookup(scope, op.path);
      if (!Array.isArray(xs)) continue;
      const len = xs.length;
      for (let k = 0; k < len; k++) {
        const vars = {};
        vars[op.name] = xs[k];
        vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
        renderOps(op.body, { vars, parent: scope }, templates, depth, out);
      }
      continue;
    }
    if (depth < 8) {
      const t = templates.get(op.name);
      if (t !== undefined) renderOps(t, scope, templates, depth + 1, out);
    }
  }
}

// ---------------------------------------------------------------- build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CR_RE = /\r\n?/g;

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function wordsCount(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 1680 ||
      (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
      c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

export function run(input) {
  const cx = { slugCache: new Map(), dateCache: new Map() };
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(CR_RE, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(cx, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(cx, s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsCount(s.body) / 200));
    s.dateStr = s.data.date ?? '';
    s.dateLong = s.data.date === undefined ? '' : longDate(cx, s.data.date);
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const sl = slugify(cx, tags[i]);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(tags[i]);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(cx, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const sl = slugify(cx, name);
        return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  for (const s of kept) {
    s.cardBase = {
      title: s.data.title,
      url: s.url,
      date: s.dateStr,
      date_long: s.dateLong,
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.link = { title: s.data.title, url: s.url, date: s.dateStr, date_long: s.dateLong };
  }
  const cards = new Map(posts.map((p) => [p, p.cardBase]));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderOps(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };

  for (const s of kept) {
    const page = {
      ...s.cardBase,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: s.post ? (s.newer === null ? null : s.newer.link) : null,
      older: s.post ? (s.older === null ? null : s.older.link) : null,
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
