// mend — apply an AI-written edit to a tree of text files.
//
// A model writes its edit in one of four shapes — a unified diff, SEARCH/REPLACE
// blocks, the V4A patch format, or JSON tool calls — and this CLI reads it the
// way SPEC.md says, then changes every file the edit names or none of them.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to stop the run with an exit-2 line (usage, no-patch, format, parse). */
class HardStop {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** Thrown by one edit to report that it failed; the tree rolls back to before it. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** SPEC section 3: a patch's lines — split at \n, one trailing \r off each. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** SPEC section 3: a path is safe when it is relative, has no backslash, and no segment is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file's text as lines, plus its break style and whether it ends with one. */
interface Doc {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** SPEC section 5: a line compared at a tier (0 exact, 1 trailing ws off, 2 both ends off). */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position where `old` occurs in `lines` at `tier` (occurrences may overlap). */
function allOccurrences(lines: string[], old: string[], tier: number): number[] {
  const hits: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (tierLine(lines[i + j], tier) !== tierLine(old[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** First tier at which `old` occurs (only tier 0 when strict), with its positions. */
function tierOccurrences(lines: string[], old: string[], strict: boolean): { tier: number; hits: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const hits = allOccurrences(lines, old, t);
    if (hits.length > 0) return { tier: t, hits };
  }
  return null;
}

/** First line at or after `from` equal to `line`, at the first tier where one is. */
function anchorLine(lines: string[], line: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierLine(lines[i], t) === tierLine(line, t)) return i;
    }
  }
  return -1;
}

/** The tree as the edits leave it; `now` holds the paths an edit touched (null: deleted). */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  orig(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }
  current(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.orig(p);
  }
}

/** What an edit needs besides the tree: the --strict flag and the moves it made. */
interface Bag {
  strict: boolean;
  moves: [string, string][];
}

type Edit = (tree: Tree, bag: Bag) => void;

/** One body line of a hunk or chunk: context (in both old and new), old only, new only. */
interface Seg {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** Split a body into its old lines and its new lines, marking which new lines are context. */
function splitBody(segs: Seg[]): { oldLines: string[]; newLines: { text: string; ctx: boolean; oIdx: number }[] } {
  const oldLines: string[] = [];
  const newLines: { text: string; ctx: boolean; oIdx: number }[] = [];
  for (const s of segs) {
    if (s.kind === 'ctx') {
      oldLines.push(s.text);
      newLines.push({ text: s.text, ctx: true, oIdx: oldLines.length - 1 });
    } else if (s.kind === 'old') {
      oldLines.push(s.text);
    } else {
      newLines.push({ text: s.text, ctx: false, oIdx: -1 });
    }
  }
  return { oldLines, newLines };
}

/**
 * Replace `oldLines` at `pos` by the new lines. A context line is written as the
 * file's own matched line, never the patch's. At tier 2 every other new line is
 * re-indented from the old lines' leading whitespace to the file's.
 */
function applyAt(
  doc: Doc,
  pos: number,
  oldLines: string[],
  newLines: { text: string; ctx: boolean; oIdx: number }[],
  tier: number,
): Doc {
  const out: string[] = [];
  if (oldLines.length > 0) {
    const leadFile = leadingWs(doc.lines[pos] ?? '');
    const leadOld = leadingWs(oldLines[0]);
    for (const nl of newLines) {
      if (nl.ctx) {
        out.push(doc.lines[pos + nl.oIdx]);
      } else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(leadOld)) {
        out.push(leadFile + nl.text.slice(leadOld.length));
      } else {
        out.push(nl.text);
      }
    }
  } else {
    for (const nl of newLines) out.push(nl.text);
  }
  const lines = [...doc.lines.slice(0, pos), ...out, ...doc.lines.slice(pos + oldLines.length)];
  return { br: doc.br, lines, final: doc.final };
}

/** SPEC section 4: work out the patch's format, or null when none of the signs hold. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- JSON (section 9)

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path as string;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text as string;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldS = o.old_str as string;
    const newS = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.current(p);
      if (before === null) throw new EditFail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const txt = toLf(before);
      const old = toLf(oldS);
      const nw = toLf(newS);
      let count = 0;
      let at = -1;
      for (let k = txt.indexOf(old); k >= 0; k = txt.indexOf(old, k + 1)) {
        count += 1;
        if (at < 0) at = k;
      }
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const out = txt.slice(0, at) + nw + txt.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const atLine = o.insert_line as number;
    const add = splitPatch(o.new_str as string);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.current(p);
      if (before === null) throw new EditFail('missing', p);
      const doc = readDoc(before);
      if (atLine < 0 || atLine > doc.lines.length) throw new EditFail('no-match', p);
      const lines = [...doc.lines];
      lines.splice(atLine, 0, ...add);
      tree.now.set(p, writeDoc({ ...doc, lines }));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new HardStop('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new HardStop(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new HardStop(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new HardStop(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new HardStop(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface UniHunk {
  a: number;
  segs: Seg[];
  /** a `\` line follows this hunk's last context or `+` line */
  noEolCtx: boolean;
  /** a `\` line follows this hunk's last `+` line */
  noEolNew: boolean;
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: UniHunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` / `+++ `: text after four chars, up to the first tab, spaces off, a/ or b/ off. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0].trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

/** Read one hunk body: lines starting with space, -, +, \ or empty, up to the first other line. */
function readHunkBody(lines: string[], start: number): { segs: Seg[]; noEolCtx: boolean; noEolNew: boolean; next: number } {
  const raw: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      i += 1;
    } else {
      break;
    }
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const segs: Seg[] = [];
  const atRaw: number[] = [];
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    if (l === '') {
      segs.push({ kind: 'ctx', text: '' });
      atRaw.push(k);
    } else if (l[0] === ' ') {
      segs.push({ kind: 'ctx', text: l.slice(1) });
      atRaw.push(k);
    } else if (l[0] === '-') {
      segs.push({ kind: 'old', text: l.slice(1) });
      atRaw.push(k);
    } else if (l[0] === '+') {
      segs.push({ kind: 'new', text: l.slice(1) });
      atRaw.push(k);
    }
    // a `\` line adds no segment; it marks the line before it.
  }
  const followsBs = (segIdx: number): boolean => {
    const at = atRaw[segIdx]!;
    return raw[at + 1] !== undefined && raw[at + 1]![0] === '\\';
  };
  let noEolCtx = false;
  let noEolNew = false;
  for (let s = segs.length - 1; s >= 0; s--) {
    if (segs[s]!.kind === 'ctx' || segs[s]!.kind === 'new') {
      noEolCtx = followsBs(s);
      break;
    }
  }
  for (let s = segs.length - 1; s >= 0; s--) {
    if (segs[s]!.kind === 'new') {
      noEolNew = followsBs(s);
      break;
    }
  }
  return { segs, noEolCtx, noEolNew, next: i };
}

/** Apply a section's hunks in order to a document, honouring the A numbers and the drift d. */
function applyUniHunks(doc: Doc, hunks: UniHunk[], strict: boolean, path: string): Doc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    const { oldLines, newLines } = splitBody(h.segs);
    if (oldLines.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > cur.lines.length) pos = cur.lines.length;
      const next = applyAt(cur, pos, oldLines, newLines, 0);
      let fin = cur.final;
      if (pos === cur.lines.length) fin = next.lines.length === 0 ? false : !h.noEolCtx;
      cur = { ...next, final: fin };
      d += newLines.length;
    } else {
      const found = tierOccurrences(cur.lines, oldLines, strict);
      if (found === null) throw new EditFail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.hits[0]!;
      for (const p of found.hits) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const next = applyAt(cur, best, oldLines, newLines, found.tier);
      let fin = cur.final;
      if (best + oldLines.length === cur.lines.length) {
        fin = next.lines.length === 0 ? false : !h.noEolCtx;
      }
      cur = { ...next, final: fin };
      d += newLines.length - oldLines.length;
    }
  }
  return cur;
}

function uniSectionEdit(sec: UniSection): Edit {
  return (tree, bag) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : (sec.renameFrom ?? sec.gitOld);
    const newP = sec.pairNew !== undefined ? sec.pairNew : (sec.renameTo ?? sec.gitNew);
    const isCreate = sec.create || oldP === null;
    const isDelete = !isCreate && (sec.del || newP === null);
    if (isCreate) {
      if (newP === null) throw new EditFail('unsafe', '');
      if (!isSafePath(newP)) throw new EditFail('unsafe', newP);
      if (tree.current(newP) !== null) throw new EditFail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const s of h.segs) if (s.kind === 'new') plus.push(s.text);
      }
      let noEol = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        if (sec.hunks[hi]!.segs.some((s) => s.kind === 'new')) {
          noEol = sec.hunks[hi]!.noEolNew;
          break;
        }
      }
      tree.now.set(newP, writeDoc({ br: '\n', lines: plus, final: plus.length > 0 && !noEol }));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new EditFail('unsafe', '');
      if (!isSafePath(oldP)) throw new EditFail('unsafe', oldP);
      if (tree.current(oldP) === null) throw new EditFail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) throw new EditFail('unsafe', '');
    if (!isSafePath(oldP)) throw new EditFail('unsafe', oldP);
    if (!isSafePath(newP)) throw new EditFail('unsafe', newP);
    const before = tree.current(oldP);
    if (before === null) throw new EditFail('missing', oldP);
    const isMove = oldP !== newP;
    if (isMove && tree.current(newP) !== null) throw new EditFail('exists', newP);
    const doc = applyUniHunks(readDoc(before), sec.hunks, bag.strict, oldP);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, writeDoc(doc));
      bag.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, writeDoc(doc));
    }
  };
}

function freshSection(gitOld: string | null, gitNew: string | null): UniSection {
  return {
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    gitOld,
    gitNew,
    create: false,
    del: false,
    hunks: [],
  };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const openDiff = (line: string, at: number): UniSection => {
    const m = DIFF_GIT.exec(line);
    if (!m) throw new HardStop(`error: parse ${at}`);
    const s = freshSection(m[1], m[2]);
    sections.push(s);
    return s;
  };
  const openPair = (oldLine: string, newLine: string): UniSection => {
    const s = freshSection(null, null);
    s.pairOld = headerPath(oldLine);
    s.pairNew = headerPath(newLine);
    sections.push(s);
    return s;
  };
  const readHunk = (at: number): void => {
    const hm = HUNK_HEAD.exec(lines[at]!);
    if (!hm) throw new HardStop(`error: parse ${at + 1}`);
    const body = readHunkBody(lines, at + 1);
    cur!.hunks.push({ a: Number(hm[1]), segs: body.segs, noEolCtx: body.noEolCtx, noEolNew: body.noEolNew });
    inHeader = false;
    i = body.next;
  };
  while (i < n) {
    const l = lines[i]!;
    if (cur === null) {
      if (l.startsWith('diff --git ')) {
        cur = openDiff(l, i + 1);
        inHeader = true;
        i += 1;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = openPair(l, lines[i + 1]!);
        inHeader = true;
        i += 2;
      } else if (l.startsWith('@@')) {
        throw new HardStop(`error: parse ${i + 1}`);
      } else {
        i += 1;
      }
    } else if (inHeader) {
      if (l.startsWith('diff --git ')) {
        cur = openDiff(l, i + 1);
        inHeader = true;
        i += 1;
      } else if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = headerPath(l);
          cur.pairNew = headerPath(lines[i + 1]!);
          i += 2;
        } else {
          throw new HardStop(`error: parse ${i + 2}`);
        }
      } else if (l.startsWith('@@')) {
        readHunk(i);
      } else if (l.startsWith('rename from ')) {
        if (cur.pairOld === undefined) cur.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
      } else if (l.startsWith('rename to ')) {
        if (cur.pairNew === undefined) cur.renameTo = l.slice('rename to '.length).trim();
        i += 1;
      } else if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
      } else if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
      } else {
        i += 1;
      }
    } else {
      if (l.startsWith('diff --git ')) {
        cur = openDiff(l, i + 1);
        inHeader = true;
        i += 1;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = openPair(l, lines[i + 1]!);
        inHeader = true;
        i += 2;
      } else if (l.startsWith('@@')) {
        readHunk(i);
      } else {
        i += 1;
      }
    }
  }
  return sections.map((s) => uniSectionEdit(s));
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, bag) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, writeDoc({ br: '\n', lines: [...newLines], final: newLines.length > 0 }));
      return;
    }
    const before = tree.current(path);
    if (before === null) throw new EditFail('missing', path);
    const doc = readDoc(before);
    const found = tierOccurrences(doc.lines, oldLines, bag.strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.hits.length > 1) throw new EditFail('ambiguous', path);
    const next = applyAt(doc, found.hits[0]!, oldLines, newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })), found.tier);
    tree.now.set(path, writeDoc(next));
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eq = -1;
    for (let j = searchAt + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new HardStop(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new HardStop(`error: parse ${searchAt + 1}`);
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new HardStop(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A (section 8)

interface VChunk {
  anchor: string | null;
  eof: boolean;
  segs: Seg[];
}

function isVSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (tree.current(path) !== null) throw new EditFail('exists', path);
    tree.now.set(path, writeDoc({ br: '\n', lines: [...fileLines], final: fileLines.length > 0 }));
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (tree.current(path) === null) throw new EditFail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return (tree, bag) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = tree.current(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.current(moveTo) !== null) throw new EditFail('exists', moveTo);
    let doc = readDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = anchorLine(doc.lines, ch.anchor, cursor, bag.strict);
        if (at < 0) throw new EditFail('no-match', path);
        cursor = at + 1;
      }
      const { oldLines, newLines } = splitBody(ch.segs);
      if (oldLines.length === 0) {
        const pos = ch.eof ? doc.lines.length : cursor;
        const next = applyAt(doc, pos, oldLines, newLines, 0);
        doc = next;
        cursor = pos + newLines.length;
      } else if (ch.eof) {
        const pos = doc.lines.length - oldLines.length;
        if (pos < cursor) throw new EditFail('no-match', path);
        const tiers = bag.strict ? [0] : [0, 1, 2];
        let tier = -1;
        for (const t of tiers) {
          if (allOccurrences(doc.lines, oldLines, t).includes(pos)) {
            tier = t;
            break;
          }
        }
        if (tier < 0) throw new EditFail('no-match', path);
        doc = applyAt(doc, pos, oldLines, newLines, tier);
        cursor = pos + newLines.length;
      } else {
        const tiers = bag.strict ? [0] : [0, 1, 2];
        let found: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const hits = allOccurrences(doc.lines, oldLines, t).filter((p) => p >= cursor);
          if (hits.length > 0) {
            found = { tier: t, pos: hits[0]! };
            break;
          }
        }
        if (found === null) throw new EditFail('no-match', path);
        doc = applyAt(doc, found.pos, oldLines, newLines, found.tier);
        cursor = found.pos + newLines.length;
      }
    }
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, writeDoc(doc));
      bag.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, writeDoc(doc));
    }
  };
}

/** Parse one V4A section's body lines (trailing blanks already stripped). */
function vSectionEdit(kind: string, path: string, body: string[], firstLine: number): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < body.length; k++) {
      const l = body[k]!;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new HardStop(`error: parse ${firstLine + k}`);
    }
    return vAddEdit(path, fileLines);
  }
  if (kind === 'delete') {
    if (body.length > 0) throw new HardStop(`error: parse ${firstLine}`);
    return vDeleteEdit(path);
  }
  // update
  let idx = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  let started = false;
  for (let k = idx; k < body.length; k++) {
    const l = body[k]!;
    const at = firstLine + k;
    if (l.startsWith('@@')) {
      if (curChunk !== null) chunks.push(curChunk);
      curChunk = { anchor: l.slice(2).trim(), eof: false, segs: [] };
      started = true;
    } else if (l === '*** End of File') {
      // Exact match: SPEC trims whitespace only for Begin/End Patch, so a line
      // like " *** End of File" is a context line of the chunk, not this marker.
      if (curChunk === null) throw new HardStop(`error: parse ${at}`);
      curChunk.eof = true;
      chunks.push(curChunk);
      curChunk = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (curChunk === null) {
        if (started) throw new HardStop(`error: parse ${at}`);
        curChunk = { anchor: null, eof: false, segs: [] };
        started = true;
      }
      if (l === '') curChunk.segs.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') curChunk.segs.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') curChunk.segs.push({ kind: 'old', text: l.slice(1) });
      else curChunk.segs.push({ kind: 'new', text: l.slice(1) });
    } else {
      throw new HardStop(`error: parse ${at}`);
    }
  }
  if (curChunk !== null) chunks.push(curChunk);
  if (chunks.length === 0 && moveTo === null) throw new HardStop(`error: parse ${firstLine - 1}`);
  return vUpdateEdit(path, moveTo, chunks);
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new HardStop('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new HardStop(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new HardStop(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (!isVSectionStart(l)) throw new HardStop(`error: parse ${i + 1}`);
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = l.slice(prefix.length).trim();
    let j = i + 1;
    while (j < last && !isVSectionStart(lines[j]!)) j += 1;
    const body = lines.slice(i + 1, j);
    while (body.length > 0 && isBlank(body[body.length - 1]!)) body.pop();
    edits.push(vSectionEdit(kind, path, body, i + 2));
    i = j;
  }
  return edits;
}

// ---------------------------------------------------------------- driver (sections 1, 2, 10)

function usageOut(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !KNOWN_FORMATS.includes(v)) return usageOut();
        format = v;
      } else if (a === '--check') {
        if (check) return usageOut();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usageOut();
        strict = true;
      } else {
        return usageOut();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usageOut();
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const bag: Bag = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new HardStop('error: parse 1');
  } catch (e) {
    if (e instanceof HardStop) return { code: 2, out: [e.text] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snapNow = new Map(tree.now);
    const snapMoves = bag.moves.length;
    try {
      edit(tree, bag);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapNow) tree.now.set(k, v);
      bag.moves.length = snapMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // Output rows, with a move folded into one R line when it qualifies.
  const suppressed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of bag.moves) {
    if (tree.orig(oldP) !== null && tree.current(oldP) === null && tree.orig(newP) === null && tree.current(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (suppressed.has(p)) continue;
    const was = tree.orig(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    // Deletions first, so a deleted path never blocks a file created under it.
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      if (now === tree.orig(p)) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
