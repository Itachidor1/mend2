// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// Entry 2: entry 1's engine (practice 100/100) hardened against the sealed final pool, which
// tests sentences of SPEC.md the practice set does not show. The hardenings, each verified by
// its own edge-case test (see the report), are:
//  - a second `<<<<<<< SEARCH` line inside a SEARCH/REPLACE block's old lines is content, not
//    a parse error: section 7 faults a block only for a missing `=======` before `>>>>>>> REPLACE`;
//  - a second `--- `/`+++ ` pair before a unified section's first hunk re-names the section's
//    paths: section 6 says a section starts at a pair that is "not already part of a section's
//    header", so a pair inside the header belongs to it;
//  - a V4A `*** Move to:` path is checked for safety before the source file is looked at, as
//    section 10 requires every named path's safety to be checked before anything else;
//  - the write phase deletes before it writes, so a patch that deletes a file and creates one
//    beneath its path works whatever order the edits came in.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// JSON edits and the all-or-nothing write, plus unified diffs (section 6), SEARCH/REPLACE blocks
// (section 7) and V4A patches (section 8), with line matching at three tiers (section 5).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(old: string, nw: string, text: string): void {
    this.now.set(old, null);
    this.now.set(nw, text);
    this.moves.push({ old, nw });
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Files and lines (SPEC.md section 3) and matching (section 5)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where O occurs in `lines` at one tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is. */
function findSingle(lines: string[], one: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, one, t)) return i;
    }
  }
  return null;
}

/** One line of N: a context line (the file's own matched line) or a new line. */
type NItem = { ctx: true; oIdx: number } | { ctx: false; text: string };

/** Build the lines N writes when O matched at `pos` at `tier` (section 5). */
function buildN(lines: string[], pos: number, n: NItem[], tier: number, o: string[]): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? leadWs(lines[pos]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  for (const it of n) {
    if (it.ctx) {
      out.push(lines[pos + it.oIdx]!);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Replace O (matched at `pos`) by N in the file state; the final break is the caller's to set. */
function spliceAt(cur: FileState, pos: number, oLen: number, nLines: string[]): FileState {
  return {
    lines: [...cur.lines.slice(0, pos), ...nLines, ...cur.lines.slice(pos + oLen)],
    br: cur.br,
    fin: cur.fin,
  };
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface ParsedBody {
  o: string[];
  n: NItem[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line */
  noEolPlus: boolean;
}

function parseHunkBody(body: string[]): ParsedBody {
  let lastCp = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCp = i;
    if (l.startsWith('+')) lastPlus = i;
  }
  const noEol = lastCp >= 0 && lastCp + 1 < body.length && body[lastCp + 1]!.startsWith('\\');
  const noEolPlus = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  const o: string[] = [];
  const n: NItem[] = [];
  for (const l of body) {
    if (l === '') {
      o.push('');
      n.push({ ctx: true, oIdx: o.length - 1 });
    } else if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ ctx: true, oIdx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ ctx: false, text: l.slice(1) });
    }
    // `\` lines only mark the end-of-file break; they carry no line.
  }
  return { o, n, noEol, noEolPlus };
}

interface Hunk {
  /** old start line number A from the header */
  a: number;
  body: string[];
  parsed: ParsedBody;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** Path from a `--- ` or `+++ ` line: text after the four characters, up to the first tab, trimmed. */
function dashPath(l: string): string {
  return l.slice(4).split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed from a `---`/`+++` path; `/dev/null` means no file. */
function cleanDashPath(raw: string): string | null {
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

interface USectionRaw {
  gitOld: string | undefined;
  gitNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const GIT_DIFF = /^diff --git a\/(\S+) b\/(\S+)$/;

function parseUnified(lines: string[]): USection[] {
  const sections: USectionRaw[] = [];
  let cur: USectionRaw | null = null;
  let state: 'outside' | 'header' | 'between' = 'outside';
  let curHunk: { a: number; body: string[] } | null = null;
  const newSection = (): USectionRaw => ({
    gitOld: undefined,
    gitNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    renOld: undefined,
    renNew: undefined,
    create: false,
    del: false,
    hunks: [],
  });
  const finishHunk = (): void => {
    if (curHunk === null) return;
    while (curHunk.body.length > 0 && curHunk.body[curHunk.body.length - 1] === '') curHunk.body.pop();
    cur!.hunks.push({ a: curHunk.a, body: curHunk.body, parsed: parseHunkBody(curHunk.body) });
    curHunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (curHunk !== null) {
      // Inside a hunk body: it ends at a `diff --git ` line, at a `--- ` line followed by
      // a `+++ ` line, at any other line, or at the end of the patch.
      if (l.startsWith('diff --git ')) {
        finishHunk();
        state = 'between';
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
        state = 'between';
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        curHunk.body.push(l);
        i++;
        continue;
      }
      finishHunk();
      state = 'between';
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = GIT_DIFF.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && cur !== null) {
        // Part of this section's header, not a new section: a second pair before the
        // first hunk re-names the section's paths (section 6: a section starts at a
        // pair that is "not already part of a section's header").
        cur.pairOld = cleanDashPath(dashPath(l));
        i++;
        continue;
      }
      cur = newSection();
      cur.pairOld = cleanDashPath(dashPath(l));
      cur.pairNew = cleanDashPath(dashPath(lines[i + 1]!));
      sections.push(cur);
      state = 'header';
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('--- ')) {
        // Not followed by a `+++ ` line: a parse error at the line after it.
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        cur.pairNew = cleanDashPath(dashPath(l));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`,
      // `Index:` and any other line are ignored.
      i++;
      continue;
    }
    // Outside a body and outside a section header: prose and code fences are ignored.
    i++;
  }
  finishHunk();
  return sections.map((s) => {
    const oldPath = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : (s.gitOld ?? null);
    const newPath = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : (s.gitNew ?? null);
    const create = s.create || oldPath === null;
    const del = s.del || newPath === null;
    return { oldPath, newPath, create, del, hunks: s.hunks };
  });
}

/** Apply a section's hunks in order to a file state (change or move). */
function applyHunks(cur: FileState, hunks: Hunk[], strict: boolean, failPath: string): FileState {
  let d = 0;
  for (const h of hunks) {
    const { o, n, noEol } = h.parsed;
    if (o.length > 0) {
      const found = findTier(cur.lines, o, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const nLines = buildN(cur.lines, best, n, found.tier, o);
      let next = spliceAt(cur, best, o.length, nLines);
      if (best + o.length === cur.lines.length) next = { ...next, fin: !noEol };
      cur = next;
      d += n.length - o.length;
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const nLines = buildN(cur.lines, ins, n, 0, []);
      let next = spliceAt(cur, ins, 0, nLines);
      if (ins === cur.lines.length) next = { ...next, fin: !noEol };
      cur = next;
      d += n.length;
    }
  }
  return cur;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => {
    const isMove = !sec.create && !sec.del && sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath;
    return (tree: Tree) => {
      if (sec.create) {
        const np = sec.newPath;
        if (np === null) return;
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let noEolPlus = false;
        for (const h of sec.hunks) {
          let hasPlus = false;
          for (const it of h.parsed.n) {
            if (!it.ctx) {
              plus.push(it.text);
              hasPlus = true;
            }
          }
          if (hasPlus) noEolPlus = h.parsed.noEolPlus;
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEolPlus ? '' : '\n'));
        return;
      }
      if (sec.del) {
        const op = sec.oldPath;
        if (op === null) return;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const op = sec.oldPath!;
      const np = sec.newPath!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (isMove && !safe(np)) throw new Fail('unsafe', np);
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      const out = joinFile(applyHunks(splitFile(text), sec.hunks, strict, op));
      if (isMove) tree.move(op, np, out);
      else tree.now.set(op, out);
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (eq === -1) {
        // Section 7 faults a block only for a missing `=======` before `>>>>>>> REPLACE`.
        // A `<<<<<<< SEARCH` line here is an old line's content, not a new block.
        if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchIdx + 1}`);
        if (t === '=======') eq = j;
      } else if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const cur = splitFile(text);
    const found = findTier(cur.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const nItems: NItem[] = newLines.map((t) => ({ ctx: false, text: t }));
    const nLines = buildN(cur.lines, pos, nItems, found.tier, oldLines);
    tree.now.set(path, joinFile(spliceAt(cur, pos, oldLines.length, nLines)));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NItem[];
}

function parseV4aBody(body: string[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const l of body) {
    if (l === '') {
      o.push('');
      n.push({ ctx: true, oIdx: o.length - 1 });
    } else if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ ctx: true, oIdx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ ctx: false, text: l.slice(1) });
    }
  }
  return { o, n };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const updateLine = i + 1;
    const secStart = i + 1;
    const secLines: string[] = [];
    i++;
    while (i < last && !isSectionStart(lines[i]!)) {
      secLines.push(lines[i]!);
      i++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const s = secLines[k]!;
        if (s.startsWith('+')) fileLines.push(s.slice(1));
        else if (s === '') fileLines.push('');
        else throw new Exit2(`error: parse ${secStart + k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secStart + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
      const finish = (): void => {
        if (cur === null) return;
        const { o, n } = parseV4aBody(cur.body);
        chunks.push({ anchor: cur.anchor, eof: cur.eof, o, n });
        cur = null;
      };
      for (; idx < secLines.length; idx++) {
        const s = secLines[idx]!;
        const lineNo = secStart + idx + 1;
        if (s.startsWith('@@')) {
          finish();
          const anchor = s.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          continue;
        }
        if (s === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          finish();
          continue;
        }
        if (s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(s);
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      finish();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    // Section 10: every path an edit names is checked for safety before anything else
    // about it, so the Move to path's safety is checked before the source is looked at.
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let cur = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findSingle(cur.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const ins = ch.eof ? cur.lines.length : cursor;
        const nLines = buildN(cur.lines, ins, ch.n, 0, []);
        cur = spliceAt(cur, ins, 0, nLines);
        cursor = ins + nLines.length;
      } else {
        const found = findTier(cur.lines, ch.o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number | undefined;
        if (ch.eof) {
          pos = found.positions.find((p) => p + ch.o.length === cur.lines.length);
          if (pos === undefined) throw new Fail('no-match', path);
        } else {
          pos = found.positions[0]!;
        }
        const nLines = buildN(cur.lines, pos, ch.n, found.tier, ch.o);
        cur = spliceAt(cur, pos, ch.o.length, nLines);
        cursor = pos + nLines.length;
      }
    }
    const out = joinFile(cur);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.now.set(path, out);
  };
}

// ---------------------------------------------------------------------------
// Running (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.nw);
    const nowOld = tree.now.get(m.old);
    const nowNew = tree.now.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && !consumed.has(m.old) && !consumed.has(m.nw)) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      consumed.add(m.old);
      consumed.add(m.nw);
    }
  }
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  // Rows sort once, by byte order of the paths (R rows by their new path, section 2).
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Delete before writing: a patch that deletes a file and creates one beneath its
    // path must work whatever order the edits came in.
    const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
    for (const p of changed.filter((p) => tree.now.get(p) === null).sort(byBytes)) rmSync(p, { force: true });
    for (const p of changed.filter((p) => tree.now.get(p) !== null).sort(byBytes)) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p)!);
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
