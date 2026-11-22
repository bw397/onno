# onno

A command-line interface in the browser. A small shell parses each line and runs
builtin commands or script files from a virtual disk stored in `localStorage`.

```bash
bun install
bun dev        # http://localhost:3000 with hot reload
bun test
bun check      # typecheck
```

## Layout

| Path            | What                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `src/shell/`    | Lexer, parser (AST), and `Shell` executor                            |
| `src/builtins/` | One file per builtin (`cat`, `cd`, `curl`, `df`, `echo`, `find`, `grep`, `ls`, `man`, `mkdir`, `pwd`, `rm`) + registry in `index.ts`   |
| `src/fs/`       | `VirtualFS` (localStorage-backed), path helpers, initial disk seed   |
| `src/settings/` | Settings context (theme, font size; persisted) + top-right menu      |
| `src/terminal/` | Terminal UI component                                                |
| `src/upload/`   | Upload button (top right) + logic to copy local files onto the disk  |

## Shell syntax

- Words, `'single'` / `"double"` quotes, `\` escapes, `# comments`
- `$VAR`, `${VAR}`, `$?`, `$1`…, `$#`, `$@`, leading `~`
- `cmd1 | cmd2`, `&&`, `||`, `;` / newline
- Redirection: `> file`, `>> file`, `< file`

Tab completes command names (builtins + `$PATH`) and paths; press Tab twice to list ambiguous matches.

Command lookup: builtins first, then a file path (if the name contains `/`), then
`$PATH` (default `/bin`). Files are run as shell scripts.

## Adding a builtin

Create `src/builtins/<name>.ts` exporting a `Builtin` and add it to the list in
`src/builtins/index.ts`. `run(ctx)` gets `args`, `stdin`, `stdout()`, `stderr()`,
`fs`, `cwd`, `env`, `signal`, `resolvePath()` and the `shell`, and returns an exit status.

The metadata is the command's manual page (`man <name>`):

- `summary`: one lower-case line, no period
- `usage`: synopsis line, then option lines (also printed on usage errors)
- `description`: prose; wrapped automatically
- `examples`: `{ command, description }[]`

Tests require every builtin to have all four (with at least two examples), and run
each example against the default disk to check it parses and has no usage errors.
Scripts on disk get a man page from the `#` comment block at their top.

## Storage keys

- `onno:fs:v1`: the disk (one JSON blob). Delete it to reset the disk to the seed.
- `onno:settings`: UI settings.

## curl

`curl` uses the browser's `fetch`, so browser rules apply: cross-origin URLs only
work if the server sends CORS headers (the app's own origin always works), some
request headers can't be set, only CORS-exposed response headers are visible,
redirects are always followed, and bodies are treated as UTF-8 text. An `https`
deployment can't fetch `http://` URLs (mixed content). Ctrl+C interrupts a request.

## Uploading

The upload button (top right) copies files from your machine into the shell's
current directory. Existing files are never overwritten (`notes.txt` becomes
`notes-1.txt`). Only UTF-8 text is accepted, since the disk stores text. Storage
is limited by the browser's localStorage quota (typically ~5 MB); a write that
doesn't fit fails with "No space left on device" and changes nothing.

## Option parsing

Builtins that take options use `parseOptions` from `src/builtins/options.ts`
(getopt-style: bundled `-abc`, `-e PAT` / `-ePAT`, `--long[=value]`, `--`).
`grep` patterns are JavaScript regexes (like `grep -E`), plus `[[:class:]]`
and `\<` / `\>`.

## find

GNU-style expressions: `-name/-iname/-path`, `-type f|d`, `-size`, `-mtime/-mmin`,
`-newer`, `-empty`, `-maxdepth/-mindepth`, `!`/`-a`/`-o`/`( )`, and actions
`-print`, `-delete`, `-prune`, `-exec CMD {} \;` / `{} +`. The shell has no glob
expansion, so `*.txt` reaches find unexpanded; `;` and `(` still need escaping.
Builtins can run other commands with `shell.runArgv(argv, io)`.

## df

Browsers have no API for localStorage usage or quota, so `df` measures them:
used is the exact character count of every key and value; the quota is found once
per session by binary-searching the largest value a temporary probe key can store
(~10 ms in Chromium, ~200 ms in Firefox; both report 5 MiB). Sizes are characters,
which is one byte each for ASCII text. `df -v` shows how much of it is the disk.
