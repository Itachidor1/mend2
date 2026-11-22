[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Itachidor1/mend2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Itachidor1/mend2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads each one exactly as its specification says —
then changes every file the edit names, or none of them.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory. When it is absent
  or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`. The default, `auto`, detects the format from the patch text.
- `--check` does everything but write: the same output and exit code, and no file
  is created, changed or deleted.
- `--strict` matches lines exactly, with no whitespace forgiveness.

## Formats

- **Unified diff** — `diff --git` sections and `@@` hunks. Hunks match at three
  tiers (exact, trailing whitespace ignored, both ends ignored) and land on the
  occurrence nearest the hunk's line number, so wrong line numbers still work.
- **SEARCH/REPLACE** — fenced blocks naming the file above them. The old lines
  must occur exactly once.
- **V4A** — `*** Begin Patch` / `*** End Patch` with Add, Delete and Update
  sections, anchors and an end-of-file marker. Chunks apply in order behind a
  cursor that only moves forward.
- **JSON** — one edit object per line, or a JSON array: `create`, `str_replace`
  and `insert`.

## Behaviour

- All-or-nothing: a failed edit changes nothing, the edits after it still run,
  and every failure is reported.
- Output is one line per changed file (`A`, `D`, `M`, or `R old -> new`), sorted
  in byte order, then `ok: <n> files`.
- Exit codes: `0` written, `1` some edit failed, `2` usage, unreadable patch,
  undetected format or unparsable patch.
- Node 22, standard library only. The single entrypoint is `main.ts`.

Built for the [make.fun](https://make.fun/) bounty
`hidden-spec-cli-01-run-20261122` — one patch tool for every AI edit format.

<sub>Entered on [make.fun](https://make.fun/?ref=atsy8h4m&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
