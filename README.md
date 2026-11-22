# onno

A command-line interface in the browser. A small shell parses each line and runs
builtin commands or script files from a virtual disk stored in the browser's IndexedDB.

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
| `src/builtins/` | One file per builtin (`asc`, `cat`, `cd`, `cp`, `curl`, `df`, `echo`, `find`, `grep`, `head`, `ls`, `man`, `mkdir`, `mon`, `mv`, `preview`, `pwd`, `rm`, `tail`, `touch`, `wasm`, `wc`) + registry in `index.ts`   |
| `src/fs/`       | `VirtualFS` (in memory, saved to IndexedDB), backends, path helpers, seed |
| `src/settings/` | Settings context (theme, font size; persisted) + top-right menu      |
| `src/terminal/` | Terminal UI component                                                |
| `src/editor/`   | Monaco editor pane for `mon`, Monaco setup, worker bundling           |
| `src/preview/`  | `preview` viewer pane and file-type detection                         |
| `src/pane/`     | Shared top-pane frame (title bar + close) used by `mon` and `preview` |
| `src/asc/`      | AssemblyScript compiler bridge: runs `asc` in a Web Worker on the disk |
| `src/wasm/`     | WebAssembly runner for `wasm`: signatures, AssemblyScript host imports |
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

The disk is the IndexedDB database `onno`, object store `nodes`: one record per path,
holding text (a string) or binary (a `Uint8Array`) content. Delete the database
(browser devtools → Application → IndexedDB) to reset the disk to the seed.

`onno:settings` in localStorage holds the UI settings. Older versions kept the disk
in localStorage under `onno:fs:v1`; it's moved into IndexedDB on first load, then
removed.

## curl

`curl` uses the browser's `fetch`, so browser rules apply: cross-origin URLs only
work if the server sends CORS headers (the app's own origin always works), some
request headers can't be set, only CORS-exposed response headers are visible,
redirects are always followed, and bodies are treated as UTF-8 text. An `https`
deployment can't fetch `http://` URLs (mixed content). Ctrl+C interrupts a request.

## Uploading

The upload button (top right) copies files from your machine into the shell's
current directory. Text and binary files are both stored exactly. Existing files
are never overwritten (`notes.txt` becomes `notes-1.txt`). Space is limited by the
browser's storage quota for the site, usually a large share of free disk space (see
`df`). A file that doesn't fit fails on its own with "No space left on device".

Binary files survive storage, `ls -l`, `curl -o` and `curl --data-binary @file`,
but pipes and `>` are text: `cat image.png > copy.png` corrupts the copy.

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

`df` reports the browser's own figures (`navigator.storage.estimate()`): usage for
everything the site stores, and its quota. `df -v` adds the disk's own size and
whether the browser treats the storage as persistent or may evict it under pressure.


## mon (Monaco editor)

`mon FILE` opens FILE in Monaco (the VS Code editor) in the top 80% of the screen; the
terminal stays usable in the bottom 20%. Ctrl+S or the title bar's Save writes the file
to the disk; the close button asks first if there are unsaved changes. Saving over a
file that changed on disk since it was opened asks whether to overwrite or reload.

Monaco (~4 MB) is loaded only the first time `mon` runs. Its web workers (language
services) are bundled separately, because Bun's bundler doesn't follow
`new Worker(new URL(...))`: `src/workers.ts` builds every worker (Monaco's and the
AssemblyScript compiler's); the server builds them at startup (~1 s) and serves them
at `/monaco/*.worker.js` and `/asc/asc.worker.js`, and `bun run build` writes them to
`dist/`. Monaco's
CSS (~190 KB) ends up in the main stylesheet.

## preview

`preview FILE` shows images (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG), PDFs, audio
and video in the same top pane as `mon`, with its own title bar: type, size and
dimensions; Fit/100% for images; Download; close (or Esc). The type is detected from
the file's contents, so misnamed uploads still work. SVGs are shown as images, so
scripts inside them don't run. PDFs use the browser's built-in viewer; browsers without
one get a message pointing to Download. Only one pane is open at a time, and an
editor with unsaved changes has to be saved or closed first.

## asc (AssemblyScript)

`asc` is the real AssemblyScript compiler (the `assemblyscript` package). Arguments
go to its `main()` unchanged, exactly as the `asc` executable passes them, so every
option, `asconfig.json` (`--config`, `--target`) and output file works as documented
(`asc --help`). Files are read from and written to the disk relative to the current
directory; `.wasm` output is stored as binary.

The compiler (~21 MB with Binaryen) runs in a Web Worker, loaded the first time `asc`
runs (~0.5 s), so the page stays responsive; Ctrl+C stops a compile. Binary output to
stdout (`-o` with no file name) is refused, since pipes and the terminal carry text.

## wasm (running WebAssembly)

`wasm FILE [FUNCTION [ARG...]]` instantiates a module and calls an exported function,
printing its result; arguments are converted to the parameter types (`i32`, `i64`,
`f32`, `f64`), read from the binary. With no FUNCTION it runs the module's top-level
code and then `_start` or `main` (an integer result is the exit status); `wasm -l FILE`
lists exports with signatures. `.wasm` files can be run directly (`./add.wasm add 1 2`,
or from `$PATH`).

Modules from `asc` get their host functions: `console.log`/`error`/..., `trace`, and
`abort` (failed assertions report their message and source position). Other imports
are listed as missing. Each run gets its own Web Worker, so an endless loop can't
freeze the page; Ctrl+C stops it.

```sh
echo 'export function add(a: i32, b: i32): i32 { return a + b; }' > add.ts
asc add.ts -o add.wasm && wasm add.wasm add 2 40     # 42
```
