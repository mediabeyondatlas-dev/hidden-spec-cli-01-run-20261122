# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mediabeyondatlas-dev/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mediabeyondatlas-dev/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies a patch written by an AI (or a human) to a tree of text files, in any
of the four formats AI tools actually emit. It finds the lines each edit names even
when the line numbers are wrong and the whitespace has drifted, and it changes every
file or none: a failed edit never leaves a half-applied patch behind.

## Requirements

Node.js 22 or newer. Nothing to install — the standard library alone.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file; absent or `-` means standard input. The current directory
  is the tree root; every patch path is relative to it.
- `--format=NAME` forces a format: `unified`, `search-replace`, `v4a`, `json`, or
  `auto` (the default). With `auto`, mend detects the format from the patch text.
- `--check` is a dry run: the same output and exit code, but nothing is written.
- `--strict` tries only exact (tier 0) matching; without it, mend falls back to
  trailing-whitespace, then leading-and-trailing-whitespace matching.
- Options and `PATCH` may come in any order; `--` ends the options.

## The four formats

### Unified diff

The format `git diff` and most AI tools emit, including hunks whose `-A` line numbers
are wrong — mend takes the occurrence nearest the stated line (ties: the earlier one),
and an empty old side inserts after the first `A` lines. Sections create, delete,
rename and change files; `\ No newline at end of file` is honoured.

```diff
--- a/sample.txt
+++ b/sample.txt
@@ -9,3 +9,3 @@
 two
-three
+THREE
 four
```

See `examples/unified.patch`.

### SEARCH/REPLACE blocks

A block names its file on the line before it, then the old lines, `=======`, and the
new lines. An empty old side creates the file. The old lines must occur exactly once.

```
sample.txt
<<<<<<< SEARCH
two
three
=======
two
THREE
>>>>>>> REPLACE
```

See `examples/search-replace.patch`.

### V4A

`*** Begin Patch` … `*** End Patch`, with `*** Add File:`, `*** Delete File:` and
`*** Update File:` sections. An update section may start with `*** Move to:`, and its
chunks may be anchored with `@@ <line>` or pinned to the end of the file with
`*** End of File`. Chunks apply in order, each one searching from where the last
left off.

```
*** Begin Patch
*** Update File: sample.txt
@@ one
 two
-three
+THREE
*** End Patch
```

See `examples/v4a.patch`.

### JSON edits

One JSON array of edit objects, or JSON Lines (one edit object per line):

```json
{"path": "sample.txt", "command": "str_replace", "old_str": "three", "new_str": "THREE"}
```

Commands: `create` (`path`, `file_text`), `str_replace` (`path`, `old_str`,
`new_str`), `insert` (`path`, `insert_line`, `new_str`). `str_replace` matches the
text exactly, once — twice is `ambiguous`, never is `no-match`.

See `examples/json.patch`.

## Output and exit codes

- Exit 0 — every edit applied. One line per changed path, in byte order:
  `A <path>` created, `D <path>` deleted, `M <path>` changed bytes,
  `R <old> -> <new>` moved (it replaces that pair's `D` and `A` lines and sorts by
  the new path). Then `ok: <n> file(s)`. A file whose bytes are unchanged is not
  listed; no changes is `ok: 0 files`.
- Exit 1 — at least one edit failed and nothing was written. One line
  `error: <code> <path>` per failed edit, in patch order, then
  `failed: <k> of <n> edits`. Codes: `no-match`, `ambiguous`, `missing`, `exists`,
  `unsafe`. Later edits still run, so every failure is reported.
- Exit 2 — nothing was written and exactly one line is printed: `error: usage`
  (bad arguments), `error: no-patch` (the patch file cannot be read),
  `error: format` (auto-detection found no format), or `error: parse <N>`
  (the patch cannot be read in its format; `N` is the 1-based patch line named by
  that format's section of the spec, or 1 for a patch with no edit at all).

## How matching works

An edit replaces old lines `O` by new lines `N`. `O` is found at the first of three
tiers with at least one occurrence: tier 0, every line equal; tier 1, every line
equal once trailing spaces and tabs are removed from both; tier 2, every line equal
once leading and trailing spaces and tabs are removed from both. `--strict` tries
tier 0 only. A context line (a line of both `O` and `N`) is written as the file's
own matched line, never the patch's; at tier 2 every other new line is re-indented
from the old lines' leading whitespace to the file's. A file keeps its own line
break (CRLF or LF) and its final line break, except where a format's
no-newline-at-end-of-file rule says otherwise; a created file is written LF and
ends with a line break.

Paths are checked for safety before anything else about an edit: a path must be
non-empty, relative, and have no empty, `.` or `..` segment. Edits apply in patch
order to the tree as earlier edits left it, and a failed edit changes nothing.

## Development

Run the test suite (proves all four formats work, plus the error paths):

```
node tests/run-tests.mjs
```

Run the kit's practice set (100 checks; needs the kit's `practice.json`):

```
node check.ts path/to/practice.json
```

`runner.ts` is the kit's runner, kept as it is: in a trial the grader runs
`node main.ts` with `MAKEFUN_ENV_URL` set, and `main.ts` hands over to it.

## License

MIT — see `LICENSE`.
