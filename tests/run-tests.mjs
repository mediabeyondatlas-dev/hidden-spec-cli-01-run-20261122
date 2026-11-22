// Tests for mend: run with `node tests/run-tests.mjs` from the repository root.
// Each case runs `node main.ts` in a fresh temporary directory and checks its exit
// code, its stdout and the files it leaves behind. Node 22, standard library alone.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'main.ts');
const EXAMPLES = join(ROOT, 'examples');

let passed = 0;
const failures = [];

function check(actual, expected, name) {
  if (actual === expected) {
    passed++;
  } else {
    failures.push(`${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
}

/** Run main.ts once in a fresh directory holding `files`, with `argv` and `stdin`. */
function runCase(files, argv, stdin) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-test-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const r = spawnSync(process.execPath, [MAIN, ...argv], {
      cwd: dir,
      env,
      input: stdin ?? '',
      encoding: 'utf8',
      timeout: 10000,
    });
    const out = {};
    const walk = (d, prefix) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        if (statSync(p).isDirectory()) walk(p, rel);
        else out[rel] = readFileSync(p, 'utf8');
      }
    };
    walk(dir, '');
    return { exit: r.status, stdout: r.stdout ?? '', files: out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sample = readFileSync(join(EXAMPLES, 'sample.txt'), 'utf8');
const sampleThree = 'one\ntwo\nTHREE\nfour\nfive\n';

// --- the four formats, on the shipped examples -------------------------------
for (const name of ['unified.patch', 'search-replace.patch', 'v4a.patch', 'json.patch']) {
  const patch = readFileSync(join(EXAMPLES, name), 'utf8');
  const r = runCase({ 'sample.txt': sample }, ['-'], patch);
  check(r.exit, 0, `${name}: exit`);
  check(r.stdout, 'M sample.txt\nok: 1 file\n', `${name}: stdout`);
  check(r.files['sample.txt'], sampleThree, `${name}: file`);
}

// --- unified: create, delete, move -------------------------------------------
{
  const r = runCase(
    {},
    ['-'],
    '--- /dev/null\n+++ b/made.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n',
  );
  check(r.exit, 0, 'unified create: exit');
  check(r.stdout, 'A made.txt\nok: 1 file\n', 'unified create: stdout');
  check(r.files['made.txt'], 'hello\nworld\n', 'unified create: file');
}
{
  const r = runCase(
    { 'old.txt': 'a\nb\n' },
    ['-'],
    'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n',
  );
  check(r.exit, 0, 'unified move: exit');
  check(r.stdout, 'R old.txt -> new.txt\nok: 1 file\n', 'unified move: stdout');
  check(r.files['new.txt'], 'a\nB\n', 'unified move: new file');
  check(r.files['old.txt'], undefined, 'unified move: old file gone');
}
{
  const r = runCase(
    { 'gone.txt': 'g\n' },
    ['-'],
    '--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-g\n',
  );
  check(r.exit, 0, 'unified delete: exit');
  check(r.stdout, 'D gone.txt\nok: 1 file\n', 'unified delete: stdout');
  check(r.files['gone.txt'], undefined, 'unified delete: file gone');
}

// --- unified: wrong line numbers, nearest occurrence, no-newline, CRLF --------
{
  const r = runCase(
    { 'f.txt': 'x\nmark\nx\nmark\nx\n' },
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -4,1 +4,1 @@\n-mark\n+MARK\n',
  );
  check(r.files['f.txt'], 'x\nmark\nx\nMARK\nx\n', 'unified nearest: second occurrence wins');
}
{
  const r = runCase(
    { 'f.txt': 'x\ny' },
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+Y\n\\ No newline at end of file\n',
  );
  check(r.files['f.txt'], 'x\nY', 'unified no-newline: final break dropped');
  const r2 = runCase(
    { 'f.txt': 'x\ny' },
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+Y\n',
  );
  check(r2.files['f.txt'], 'x\nY\n', 'unified no-newline: break kept without marker');
}
{
  const r = runCase(
    { 'f.txt': 'a\r\nb\r\n' },
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n',
  );
  check(r.files['f.txt'], 'a\r\nB\r\n', 'unified CRLF: break kept');
}

// --- search/replace: create, ambiguous, parse error ---------------------------
{
  const r = runCase({}, ['-'], 'new.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n');
  check(r.exit, 0, 's/r create: exit');
  check(r.files['new.txt'], 'hello\n', 's/r create: file');
}
{
  const r = runCase(
    { 'f.txt': 'a\nb\na\nb\n' },
    ['-'],
    'f.txt\n<<<<<<< SEARCH\na\nb\n=======\nc\n>>>>>>> REPLACE\n',
  );
  check(r.exit, 1, 's/r ambiguous: exit');
  check(r.stdout, 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', 's/r ambiguous: stdout');
  check(r.files['f.txt'], 'a\nb\na\nb\n', 's/r ambiguous: nothing written');
}
{
  const r = runCase({ 'f.txt': 'a\n' }, ['-'], 'f.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n');
  check(r.exit, 2, 's/r parse: exit');
  check(r.stdout, 'error: parse 2\n', 's/r parse: stdout');
}

// --- search/replace: tier-2 re-indent, and --strict ---------------------------
{
  const r = runCase(
    { 'f.txt': '  a = 1;\n  b = 2;\n' },
    ['-'],
    'f.txt\n<<<<<<< SEARCH\na = 1;\n=======\na = 1;\nb = 9;\n>>>>>>> REPLACE\n',
  );
  check(r.files['f.txt'], '  a = 1;\n  b = 9;\n  b = 2;\n', 'tier 2: new lines re-indented');
}
{
  const patch = 'f.txt\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n';
  const loose = runCase({ 'f.txt': 'a \n' }, ['-'], patch);
  check(loose.exit, 0, 'tier 1: trailing space matches');
  const strict = runCase({ 'f.txt': 'a \n' }, ['--strict', '-'], patch);
  check(strict.exit, 1, '--strict: exit');
  check(strict.stdout, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', '--strict: stdout');
}

// --- V4A: add, update, delete, move, anchor, end-of-file ----------------------
{
  const r = runCase(
    { 'gone.txt': 'g\n', 'keep.txt': 'anchor line\nold\ntail\n' },
    ['-'],
    '*** Begin Patch\n*** Add File: added.txt\n+one\n+two\n*** Delete File: gone.txt\n*** Update File: keep.txt\n*** Move to: moved.txt\n@@ anchor line\n-old\n+new\n*** End Patch\n',
  );
  check(r.exit, 0, 'v4a mixed: exit');
  check(
    r.stdout,
    'A added.txt\nD gone.txt\nR keep.txt -> moved.txt\nok: 3 files\n',
    'v4a mixed: stdout',
  );
  check(r.files['added.txt'], 'one\ntwo\n', 'v4a mixed: added');
  check(r.files['moved.txt'], 'anchor line\nnew\ntail\n', 'v4a mixed: moved');
  check(r.files['keep.txt'], undefined, 'v4a mixed: old path gone');
  check(r.files['gone.txt'], undefined, 'v4a mixed: deleted');
}
{
  const r = runCase(
    { 'f.txt': 'a\nb\nc' },
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@\n-c\n+C\n*** End of File\n*** End Patch\n',
  );
  check(r.exit, 0, 'v4a eof: exit');
  check(r.files['f.txt'], 'a\nb\nC', 'v4a eof: last line replaced, no break added');
}
{
  const r = runCase({}, ['-'], '*** Begin Patch\n*** Update File: f.txt\n');
  check(r.exit, 2, 'v4a parse: exit');
  check(r.stdout, 'error: parse 3\n', 'v4a parse: stdout');
}

// --- JSON: create, str_replace ambiguous, insert parse fault ------------------
{
  const r = runCase({}, ['-'], '[{"path": "j.txt", "command": "create", "file_text": "hi"}]');
  check(r.exit, 0, 'json create: exit');
  check(r.files['j.txt'], 'hi', 'json create: file');
}
{
  const r = runCase(
    { 'f.txt': 'aa aa' },
    ['-'],
    '[{"path":"f.txt","command":"str_replace","old_str":"aa","new_str":"bb"}]',
  );
  check(r.exit, 1, 'json ambiguous: exit');
  check(r.stdout, 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', 'json ambiguous: stdout');
}
{
  const r = runCase(
    { 'f.txt': 'a\n' },
    ['-'],
    '{"path":"f.txt","command":"insert","insert_line":1.5,"new_str":"x"}',
  );
  check(r.exit, 2, 'json fault: exit');
  check(r.stdout, 'error: parse 1\n', 'json fault: stdout');
}
{
  const r = runCase(
    { 'f.txt': 'a\nc\n' },
    ['-'],
    '{"path":"f.txt","command":"insert","insert_line":1,"new_str":"b"}',
  );
  check(r.files['f.txt'], 'a\nb\nc\n', 'json insert: line inserted');
}

// --- failures, atomicity, --check, noop, CLI errors ---------------------------
{
  const r = runCase({}, ['-'], '--- a/no.txt\n+++ b/no.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
  check(r.exit, 1, 'missing: exit');
  check(r.stdout, 'error: missing no.txt\nfailed: 1 of 1 edits\n', 'missing: stdout');
}
{
  const patch =
    'a.txt\n<<<<<<< SEARCH\nx\n=======\nX\n>>>>>>> REPLACE\nmissing.txt\n<<<<<<< SEARCH\ny\n=======\nY\n>>>>>>> REPLACE\n';
  const r = runCase({ 'a.txt': 'x\n' }, ['-'], patch);
  check(r.exit, 1, 'atomicity: exit');
  check(r.stdout, 'error: missing missing.txt\nfailed: 1 of 2 edits\n', 'atomicity: stdout');
  check(r.files['a.txt'], 'x\n', 'atomicity: first edit rolled back');
}
{
  const patch = '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n';
  const r = runCase({ 'f.txt': 'a\n' }, ['--check', '-'], patch);
  check(r.exit, 0, '--check: exit');
  check(r.stdout, 'M f.txt\nok: 1 file\n', '--check: stdout');
  check(r.files['f.txt'], 'a\n', '--check: nothing written');
}
{
  const r = runCase(
    { 'f.txt': 'a\n' },
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+a\n',
  );
  check(r.exit, 0, 'noop: exit');
  check(r.stdout, 'ok: 0 files\n', 'noop: stdout');
}
{
  check(runCase({}, ['--bogus'], '').stdout, 'error: usage\n', 'usage: stdout');
  check(runCase({}, ['--bogus'], '').exit, 2, 'usage: exit');
  check(runCase({}, ['nope.patch'], '').stdout, 'error: no-patch\n', 'no-patch: stdout');
  check(runCase({}, [], 'hello world').stdout, 'error: format\n', 'format: stdout');
  check(runCase({}, [], '').stdout, 'error: format\n', 'empty patch: format');
  check(runCase({}, ['--format=v4a', '-'], '{"a":1}').stdout, 'error: parse 1\n', 'forced format: parse');
}

if (failures.length === 0) {
  process.stdout.write(`${passed} checks passed\n`);
} else {
  for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
  process.stdout.write(`${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
