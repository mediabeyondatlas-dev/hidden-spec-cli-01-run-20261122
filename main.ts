// main.ts — mend, one patch tool for every AI edit format. Node 22, the standard
// library alone. Run it as `node main.ts [options] [PATCH]`.
//
// mend reads one patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three matching
// tiers (exact, trailing whitespace, both ends), and changes every file or none,
// printing what it changed or why it failed. Full contract: SPEC.md in the kit.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 parse/usage failure: one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: `error: <code> <path>`, reported with the other failures. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Patch lines: text split at \n, one trailing \r removed from each, no empty piece
 *  after a final \n. Line numbers count these from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is non-empty, relative, and has no empty, `.` or `..` segment. */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** One file as lines: its break (CRLF when its first line feed follows a CR, else LF),
 *  its lines, and whether it ends with a break. An empty file has no lines and no break. */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** The tree as the edits leave it: paths an edit touched live in `now` (null: deleted),
 *  everything else is read from disk as it was before the patch. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old path, new path]. */
  readonly moves: [string, string][] = [];

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
}

type Edit = (tree: Tree) => void;

/** Format detection, in the order SPEC.md section 4 gives: v4a, json, search-replace,
 *  unified. A named --format is read as that format whatever the text holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

/** A line's key at a matching tier: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function lineKey(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Occurrences of O in the file's lines, at the first tier with one (SPEC.md section 5).
 *  `--strict` tries tier 0 only. Occurrences may overlap. */
function findOccurrences(
  lines: string[],
  o: string[],
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const keys = o.map((l) => lineKey(l, tier));
    const positions: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (lineKey(lines[i + j]!, tier) !== keys[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one. */
function findFrom(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const keys = o.map((l) => lineKey(l, tier));
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (lineKey(lines[i + j]!, tier) !== keys[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const key = lineKey(anchor, tier);
    for (let i = from; i < lines.length; i++) {
      if (lineKey(lines[i]!, tier) === key) return i;
    }
  }
  return -1;
}

/** One line of N: a context line names its index in O; a new line names none. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Replace O at `pos` by N. A context line is written as the file's own matched line,
 *  never the patch's. At tier 2 every other non-empty, non-whitespace line of N that
 *  starts with the leading whitespace of O's first line has that whitespace replaced
 *  by the leading whitespace of the file's first matched line. */
function applyLines(lines: string[], o: string[], n: NewLine[], pos: number, tier: number): string[] {
  const f = leadingWs(lines[pos] ?? '');
  const p = leadingWs(o[0] ?? '');
  const out = n.map((nl) => {
    if (nl.ctx !== null) return lines[pos + nl.ctx]!;
    if (tier === 2 && nl.text !== '' && !/^[ \t]*$/.test(nl.text) && nl.text.startsWith(p))
      return f + nl.text.slice(p.length);
    return nl.text;
  });
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

/* ------------------------------------------------------------------ unified diff */

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s|$)/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** One hunk: its -A number, its old lines, its new lines, and whether a `\` line
 *  follows its last context or `+` line (`noBreak`) or its last `+` line (`plusNoBreak`). */
interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  noBreak: boolean;
  plusNoBreak: boolean;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const stripPrefix = (p: string): string =>
  p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;

/** The path of a `--- ` or `+++ ` header line: after the four characters, up to the
 *  first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** Apply a section's hunks, in order, to a file's text. `d` is the running sum of
 *  (new length minus old length) over the hunks applied so far: a non-empty O is taken
 *  at the occurrence nearest A-1+d (ties: the earlier one), an empty O inserts after
 *  the first A+d lines. A hunk whose matched lines run to the end of the file (or an
 *  empty-O insertion at the end) leaves the result ending with a line break unless a
 *  `\` line follows the hunk's last context or `+` line. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const hunk of hunks) {
    if (hunk.o.length === 0) {
      const at = Math.min(hunk.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      const ins = hunk.n.map((x) => x.text);
      f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
      if (atEnd) f.final = !hunk.noBreak;
      d += ins.length;
    } else {
      const found = findOccurrences(f.lines, hunk.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const toEnd = best + hunk.o.length === f.lines.length;
      f.lines = applyLines(f.lines, hunk.o, hunk.n, best, found.tier);
      if (toEnd) f.final = !hunk.noBreak;
      d += hunk.n.length - hunk.o.length;
    }
  }
  return joinFile(f);
}

function applyUnifiedSection(tree: Tree, sec: Section, strict: boolean): void {
  const oldPath =
    sec.pairOld !== undefined
      ? sec.pairOld
      : sec.renameOld !== undefined
        ? sec.renameOld
        : (sec.diffOld ?? null);
  const newPath =
    sec.pairNew !== undefined
      ? sec.pairNew
      : sec.renameNew !== undefined
        ? sec.renameNew
        : (sec.diffNew ?? null);
  const isCreate = oldPath === null || sec.isCreate;
  const isDelete = !isCreate && (newPath === null || sec.isDelete);
  if (isCreate) {
    // A created file is the `+` lines of all its hunks, in order, LF, ending with a
    // line break unless a `\` line follows its last `+` line.
    if (newPath === null) throw new Fail('unsafe', '/dev/null');
    if (!safe(newPath)) throw new Fail('unsafe', newPath);
    if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const plus: string[] = [];
    let plusNoBreak = false;
    for (const hunk of sec.hunks) {
      for (const nl of hunk.n) if (nl.ctx === null) plus.push(nl.text);
      if (hunk.n.some((nl) => nl.ctx === null)) plusNoBreak = hunk.plusNoBreak;
    }
    tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (plusNoBreak ? '' : '\n'));
    return;
  }
  if (isDelete) {
    if (oldPath === null) throw new Fail('unsafe', '/dev/null');
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, null);
    return;
  }
  if (oldPath !== newPath) {
    if (!safe(oldPath!)) throw new Fail('unsafe', oldPath!);
    if (!safe(newPath!)) throw new Fail('unsafe', newPath!);
    const text = tree.get(oldPath!);
    if (text === null) throw new Fail('missing', oldPath!);
    if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    const out = applyHunks(text, sec.hunks, strict, oldPath!);
    tree.now.set(oldPath!, null);
    tree.now.set(newPath!, out);
    tree.moves.push([oldPath!, newPath!]);
    return;
  }
  if (!safe(oldPath!)) throw new Fail('unsafe', oldPath!);
  const text = tree.get(oldPath!);
  if (text === null) throw new Fail('missing', oldPath!);
  tree.now.set(oldPath!, applyHunks(text, sec.hunks, strict, oldPath!));
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'hunks' = 'outside';
  let hasPair = false;
  let i = 0;

  const startSection = (sec: Section): void => {
    if (cur !== null) sections.push(cur);
    cur = sec;
    state = 'header';
    hasPair = false;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({
        pairOld: undefined,
        pairNew: undefined,
        renameOld: undefined,
        renameNew: undefined,
        diffOld: m[1],
        diffNew: m[2],
        isCreate: false,
        isDelete: false,
        hunks: [],
      });
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = headerPath(line);
        const newP = headerPath(next);
        const pairOld = oldP === '/dev/null' ? null : stripPrefix(oldP);
        const pairNew = newP === '/dev/null' ? null : stripPrefix(newP);
        if (state === 'outside' || state === 'hunks') {
          startSection({
            pairOld,
            pairNew,
            renameOld: undefined,
            renameNew: undefined,
            diffOld: undefined,
            diffNew: undefined,
            isCreate: false,
            isDelete: false,
            hunks: [],
          });
          hasPair = true;
        } else if (!hasPair) {
          cur!.pairOld = pairOld;
          cur!.pairNew = pairNew;
          hasPair = true;
        }
        // A later pair in the same header is ignored: the first pair names the paths.
        i += 2;
        continue;
      }
      // A `--- ` line not followed by `+++ `, inside a section's header, is a parse
      // error at the line after it. Outside a header it is ignored prose.
      if (state === 'header') throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (state === 'outside' || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      // The body: lines starting with ` `, `-`, `+` or `\`, or empty (an empty line
      // is a context line with empty text). It ends at the first other line, at a
      // `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the
      // end of the patch. Empty lines at the end of a body are not part of it.
      const body: { mark: string; text: string }[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (
          bl === '' ||
          bl.startsWith(' ') ||
          bl.startsWith('-') ||
          bl.startsWith('+') ||
          bl.startsWith('\\')
        ) {
          body.push({ mark: bl === '' ? ' ' : bl[0]!, text: bl === '' ? '' : bl.slice(1) });
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.mark === ' ' && body[body.length - 1]!.text === '')
        body.pop();
      const o: string[] = [];
      const n: NewLine[] = [];
      for (const b of body) {
        if (b.mark === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: o.length - 1 });
        } else if (b.mark === '-') o.push(b.text);
        else if (b.mark === '+') n.push({ text: b.text, ctx: null });
      }
      let noBreak = false;
      let plusNoBreak = false;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.mark === ' ' || body[k]!.mark === '+') {
          noBreak = k + 1 < body.length && body[k + 1]!.mark === '\\';
          break;
        }
      }
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.mark === '+') {
          plusNoBreak = k + 1 < body.length && body[k + 1]!.mark === '\\';
          break;
        }
      }
      cur.hunks.push({ a, o, n, noBreak, plusNoBreak });
      state = 'hunks';
      continue;
    }
    // Any other line: in a header it may name the paths or the mode; outside bodies
    // it is ignored (prose, code fences, index lines).
    if (state === 'header' && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  return sections.map((sec) => (tree: Tree) => applyUnifiedSection(tree, sec, strict));
}

/* ------------------------------------------------------------ SEARCH/REPLACE */

function applySearchReplace(
  tree: Tree,
  path: string,
  oldLines: string[],
  newLines: string[],
  strict: boolean,
): void {
  if (!safe(path)) throw new Fail('unsafe', path);
  if (oldLines.length === 0) {
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    return;
  }
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  const f = splitFile(text);
  const found = findOccurrences(f.lines, oldLines, strict);
  if (found === null) throw new Fail('no-match', path);
  if (found.positions.length > 1) throw new Fail('ambiguous', path);
  const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
  const out = applyLines(f.lines, oldLines, n, found.positions[0]!, found.tier);
  tree.now.set(path, joinFile({ ...f, lines: out }));
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let blockStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // The path: the nearest line before SEARCH, after the previous block's
    // `>>>>>>> REPLACE` (or the start of the patch), that is not blank and, trimmed,
    // does not start with three backticks. Failing that, the previous block's path;
    // the first block with none is a parse error at its SEARCH line.
    let path: string | null = null;
    for (let k = i - 1; k >= blockStart; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    // A SEARCH line with no `=======` and then `>>>>>>> REPLACE` after it is a
    // parse error at the SEARCH line.
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k]!;
      if (l.trimEnd() === '=======') {
        eq = k;
        break;
      }
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      const l = lines[k]!;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree) => applySearchReplace(tree, p, oldLines, newLines, strict));
    prevPath = p;
    blockStart = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* --------------------------------------------------------------------- V4A */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { text: string; no: number }[];
}

function applyV4AUpdate(
  tree: Tree,
  path: string,
  moveTo: string | null,
  chunks: VChunk[],
  strict: boolean,
): void {
  if (!safe(path)) throw new Fail('unsafe', path);
  if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
  const f = splitFile(text);
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      const idx = findAnchor(f.lines, chunk.anchor, cursor, strict);
      if (idx === -1) throw new Fail('no-match', path);
      cursor = idx + 1;
    }
    const o: string[] = [];
    const n: NewLine[] = [];
    for (const b of chunk.body) {
      if (b.text.startsWith(' ')) {
        const t = b.text.slice(1);
        o.push(t);
        n.push({ text: t, ctx: o.length - 1 });
      } else if (b.text.startsWith('-')) o.push(b.text.slice(1));
      else if (b.text.startsWith('+')) n.push({ text: b.text.slice(1), ctx: null });
      else {
        o.push('');
        n.push({ text: '', ctx: o.length - 1 });
      }
    }
    if (o.length === 0) {
      const at = chunk.eof ? f.lines.length : cursor;
      const ins = n.map((x) => x.text);
      f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
      cursor = at + ins.length;
    } else {
      const found = findFrom(f.lines, o, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      if (chunk.eof && found.pos + o.length !== f.lines.length) {
        // An end-of-file chunk takes only an occurrence ending at the file's last
        // line, at the tier the first occurrence at or after the cursor was found.
        const endPos = f.lines.length - o.length;
        let ok = endPos >= cursor;
        if (ok) {
          for (let j = 0; j < o.length; j++) {
            if (lineKey(f.lines[endPos + j]!, found.tier) !== lineKey(o[j]!, found.tier)) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) throw new Fail('no-match', path);
        f.lines = applyLines(f.lines, o, n, endPos, found.tier);
        cursor = endPos + n.length;
      } else {
        f.lines = applyLines(f.lines, o, n, found.pos, found.tier);
        cursor = found.pos + n.length;
      }
    }
  }
  const out = joinFile(f);
  if (moveTo !== null) {
    tree.now.set(path, null);
    tree.now.set(moveTo, out);
    tree.moves.push([path, moveTo]);
  } else {
    tree.now.set(path, out);
  }
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
  if (lines[last]!.trim() !== '*** End Patch')
    throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice(13).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice(16).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice(16).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i + 1;
    // The section's lines, up to the next section or `*** End Patch`. Blank lines
    // at the end of a section are not part of it.
    const body: { text: string; no: number }[] = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:'))
        break;
      body.push({ text: l, no: i + 1 });
      i++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else if (b.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      const p = path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      const p = path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (body.length > 0 && body[0]!.text.startsWith('*** Move to:')) {
        moveTo = body[0]!.text.slice(12).trim();
        j = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seen = false;
      while (j < body.length) {
        const b = body[j]!;
        if (b.text.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = b.text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          seen = true;
          j++;
        } else if (b.text.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            seen = true;
          } else {
            cur.eof = true;
          }
          chunks.push(cur);
          cur = null;
          j++;
        } else if (
          b.text.startsWith(' ') ||
          b.text.startsWith('-') ||
          b.text.startsWith('+') ||
          b.text === ''
        ) {
          if (cur === null) {
            // The first chunk may start at a body line; later chunks start at `@@`.
            if (!seen) {
              cur = { anchor: null, eof: false, body: [] };
              seen = true;
            } else {
              throw new Exit2(`error: parse ${b.no}`);
            }
          }
          cur.body.push(b);
          j++;
        } else {
          throw new Exit2(`error: parse ${b.no}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      const p = path;
      const mt = moveTo;
      edits.push((tree: Tree) => applyV4AUpdate(tree, p, mt, chunks, strict));
    }
  }
  return edits;
}

/* -------------------------------------------------------------------- JSON */

function jsonEdit(tree: Tree, edit: any, path: string): void {
  if (edit.command === 'create') {
    if (typeof edit.path !== 'string' || typeof edit.file_text !== 'string')
      throw new Fail('parse', path);
    if (!safe(edit.path)) throw new Fail('unsafe', edit.path);
    if (tree.get(edit.path) !== null) throw new Fail('exists', edit.path);
    tree.now.set(edit.path, edit.file_text);
    return;
  }
  const exists = (): string => {
    if (typeof edit.path !== 'string') throw new Fail('parse', path);
    if (!safe(edit.path)) throw new Fail('unsafe', edit.path);
    const text = tree.get(edit.path);
    if (text === null) throw new Fail('missing', edit.path);
    return text;
  };
  if (edit.command === 'str_replace') {
    if (typeof edit.old_str !== 'string' || edit.old_str === '' || typeof edit.path !== 'string')
      throw new Fail('parse', path);
    if (typeof edit.new_str !== 'string' && edit.new_str !== undefined)
      throw new Fail('parse', path);
    const text = exists();
    const crlf = text.includes('\r\n');
    const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
    const t = norm(text);
    const oldS = norm(edit.old_str);
    const newS = norm(edit.new_str ?? '');
    let count = 0;
    let at = -1;
    for (let p = t.indexOf(oldS); p !== -1; p = t.indexOf(oldS, p + 1)) {
      count++;
      at = p;
    }
    if (count === 0) throw new Fail('no-match', edit.path);
    if (count > 1) throw new Fail('ambiguous', edit.path);
    const out = t.slice(0, at) + newS + t.slice(at + oldS.length);
    tree.now.set(edit.path, crlf ? out.replaceAll('\n', '\r\n') : out);
    return;
  }
  if (edit.command === 'insert') {
    if (typeof edit.insert_line !== 'number' || !Number.isInteger(edit.insert_line))
      throw new Fail('parse', path);
    if (typeof edit.new_str !== 'string' || typeof edit.path !== 'string')
      throw new Fail('parse', path);
    const text = exists();
    const f = splitFile(text);
    if (edit.insert_line < 0 || edit.insert_line > f.lines.length)
      throw new Fail('no-match', edit.path);
    const added =
      edit.new_str === '' ? [] : patchLines(edit.new_str.endsWith('\n') ? edit.new_str : edit.new_str + '\n');
    f.lines.splice(edit.insert_line, 0, ...added);
    tree.now.set(edit.path, joinFile(f));
    return;
  }
  throw new Fail('parse', path);
}

function jsonEdits(lines: string[], text: string): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  const parse = (lineNo: number): any => {
    throw new Exit2(`error: parse ${lineNo}`);
  };
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return parse(first + 1);
    }
    if (!Array.isArray(parsed)) return parse(first + 1);
    return parsed.map((edit, idx) => (tree: Tree) => {
      const isObj = edit !== null && typeof edit === 'object' && !Array.isArray(edit);
      if (!isObj || typeof edit.path !== 'string' || typeof edit.command !== 'string') parse(first + 1);
      jsonEdit(tree, edit, 'x');
      void idx;
    });
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (blank(l)) continue;
    let edit: any;
    try {
      edit = JSON.parse(l);
    } catch {
      return parse(i + 1);
    }
    const isObj = edit !== null && typeof edit === 'object' && !Array.isArray(edit);
    if (!isObj || typeof edit.path !== 'string' || typeof edit.command !== 'string') parse(i + 1);
    const lineNo = i + 1;
    edits.push((tree: Tree) => {
      try {
        jsonEdit(tree, edit, 'x');
      } catch (e) {
        if (e instanceof Fail && e.code === 'parse') throw new Exit2(`error: parse ${lineNo}`);
        throw e;
      }
    });
  }
  return edits;
}

/* --------------------------------------------------------------------- run */

function run(argv: string[]): number {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let file: string | null = null;
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('--format=')) {
      const v = a.slice(9);
      if (format !== null || !FORMATS.includes(v)) return usage();
      format = v;
      continue;
    }
    if (!ended && a === '--check') {
      if (check) return usage();
      check = true;
      continue;
    }
    if (!ended && a === '--strict') {
      if (strict) return usage();
      strict = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') return usage();
    if (file !== null) return usage();
    file = a === '-' ? null : a;
  }

  let text: string;
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    return out2('error: no-patch');
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return out2('error: format');

  const tree = new Tree();
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(lines, text);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return out2(e.line);
    throw e;
  }
  if (edits.length === 0) return out2('error: parse 1');

  const failures: Fail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    const snapMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof Fail) {
        failures.push(e);
        tree.now.clear();
        for (const [k, v] of snap) tree.now.set(k, v);
        tree.moves.length = snapMoves;
      } else throw e;
    }
  }

  const out: string[] = [];
  if (failures.length > 0) {
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }

  // Rows: A (created), D (deleted), M (changed bytes), R (a move: the old path existed
  // before and does not after, the new path did not exist before and does after; the
  // R line replaces that pair's D and A lines and sorts by the new path).
  const rows: { key: string; text: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));

  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  for (const r of rows) out.push(r.text);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return out1(out);
}

function usage(): number {
  return out2('error: usage');
}

function out1(lines: string[]): number {
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

function out2(line: string): number {
  process.stdout.write(line + '\n');
  return 2;
}

/* ------------------------------------------------------- runner hand-over */

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    if (e instanceof Exit2) process.exitCode = out2(e.line);
    else throw e;
  }
}
