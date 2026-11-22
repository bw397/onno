# CLAUDE.md

onno is a terminal in the browser: a small shell that runs builtin commands, or script
files from a virtual disk saved in IndexedDB. It uses Bun, React 19 and TypeScript
(strict, with `noUncheckedIndexedAccess`). It's entirely client-side: `src/index.ts`
only serves `index.html`.

## Commands

```bash
bun dev          # dev server with HMR, http://localhost:3000
bun test         # all tests (*.test.ts next to the code)
bun check        # typecheck, run it alongside tests before calling anything done
bun run build    # production bundle into dist/
```

## Layout

- `src/shell/`: `lexer.ts` turns a line into tokens, `parser.ts` builds an AST, and
  `Shell.ts` runs it. `complete.ts` does Tab completion. `types.ts` holds the `Builtin`,
  `CommandContext` and `IO` contracts.
- `src/builtins/`: one file per command, registered in `index.ts`. `options.ts` is the
  shared getopt-style parser.
- `src/fs/`: `VirtualFS` (an in-memory path -> node map), `backend.ts` (the
  `StorageBackend` interface + `MemoryBackend`), `idb.ts` (`IndexedDBBackend`),
  `content.ts` (text/binary helpers), `legacy.ts` (importing the old localStorage disk),
  `path.ts` and `seed.ts`.
- `src/editor/`: the `mon` editor. `EditorPane.tsx` is the UI, `monaco.ts` is the
  lazily imported Monaco setup, and `workers.ts` bundles Monaco's web workers
  (server-side).
- `src/asc/`: the AssemblyScript compiler bridge. `compile.ts` is the core (argv
  passed to `asc.main()` unchanged, file access redirected), `worker.ts`/`client.ts`/
  `protocol.ts` run it in a Web Worker, and `inprocess.ts` runs it on the current
  thread (tests only).
- `src/wasm/`: the `wasm` runner. `inspect.ts` parses signatures from the binary and
  can defer a start function, `imports.ts` holds the AssemblyScript host functions,
  `run.ts` is the thread-agnostic core, and `worker.ts`/`client.ts` run it in a worker.
- `src/workers.ts` (server-side): bundles every Web Worker (Monaco's, asc's, wasm's).
- `src/preview/`: the `preview` viewer (`PreviewPane.tsx`) and `viewable.ts` (file
  type detection from magic bytes, then extension).
- `src/pane/Pane.tsx`: the shared top-pane frame (title bar + close) used by both.
- `src/terminal/`, `src/settings/`, `src/upload/`: the rest of the React UI. `App.tsx`
  wires them together.

## Shell semantics (deliberately simple, keep them in mind)

- Supported: quotes, `\` escapes, `$VAR`/`${VAR}`/`$?`/`$1`/`$#`/`$@`, a leading `~`,
  `|`, `&&`, `||`, `;`, `>`, `>>`, `<` and `#` comments.
- **No glob expansion, word splitting, variable assignment, or `$(...)`.** `*.txt`
  reaches commands unexpanded, which is why `find -name *.txt` works unquoted.
- Pipes are buffered: each stage runs to completion before the next one starts.
- Lookup order: builtin, then a path (if the name contains `/`), then `$PATH`
  (`/bin`). Files run as shell scripts, nesting at most 32 deep.
- Exit statuses: 127 not found, 126 is a directory, 2 parse error, 130 interrupted.

## Writing a builtin

1. Create `src/builtins/<name>.ts` exporting a `Builtin`, and add it to the array in
   `index.ts`.
2. Fill in `summary` (lower case, no period), `usage` (a synopsis line, then option
   lines), `description` and at least two `examples`. **These are the man page.**
   `man.test.ts` fails if any is missing. It also *runs every example*, in order, in
   one shell on the default seeded disk: later examples may build on earlier ones, and
   none may hit usage errors or "not found". Examples that need the network belong to
   `curl`, which is excluded.
3. Parse options with `parseOptions` from `options.ts`; throw/catch `OptionError` for
   usage errors. (`flags.ts` is an older boolean-only helper still used by
   ls/mkdir/rm.)
4. Conventions:
   - Report errors as `<cmd>: <operand>: <message>` on stderr and keep going through
     the remaining operands.
   - Exit codes follow GNU (grep: 0/1/2, man: 16, curl: its own codes).
   - Catch `FsError` (its `message` is the familiar text, e.g. "No such file or
     directory"). Let other errors propagate.
   - Use `ctx.resolvePath()`; never interpret paths relative to anything else.
   - Long-running or async work must honour `ctx.signal` (Ctrl+C) and return 130.
   - Read standard input with `await ctx.readStdin()` (all of it) or
     `for await (const chunk of ctx.stdinChunks())` (as it arrives, to stream like
     `cat`). Only read stdin when the command actually needs it: from the terminal,
     reading waits for the user to type and press Ctrl+D. `ctx.stdinIsTerminal` says
     which case you're in.
   - To launch another command, use `ctx.shell.runArgv(argv, io)` (as `find -exec`
     does).
   - Commands that delete things must refuse the working directory and its parents,
     like `rm` and `find -delete` do.
   - UI features come through `ctx.shell.host` (`ShellHost`, set by `App.tsx`). It's
     undefined in tests and headless use, so check for it (see `mon`). Unit-test such
     commands with a fake host.
5. Mirror GNU behaviour where it's cheap. For grep and find, the outputs were checked
   against the system's GNU tools; keep it that way. **In Claude Code's Bash tool,
   `grep` and `find` are shell functions that run an embedded ugrep and bfs**, which
   behave differently (e.g. binary-file messages, `./` prefixes). Compare against
   `/usr/bin/grep` and `/usr/bin/find` (GNU grep 3.12, findutils 4.11), or run through
   a fresh `bash -c`.

## Standard input

- A command's stdin is a `StdinSource` (`read()` → next chunk or null). The shell
  builds it: the first stage of a pipeline reads the terminal (`IO.readLine`, provided
  by `Terminal.tsx`) if there is one, otherwise empty input. Later stages and `<` read
  text. Scripts share their caller's stdin.
- The terminal shows an input line without a prompt while a command waits (`reading`
  state). Enter echoes the line and delivers it with "\n"; Ctrl+D delivers end of
  input on an empty line, or the partial line without "\n"; Ctrl+C aborts the command
  and resolves the pending read with null. A command interrupted that way exits 130.
- Tests drive it by passing `readLine` to `shell.run` (see `src/shell/stdin.test.ts`).
  In browser tests, `.terminal[data-busy]` means a command is running; the input line
  can be visible while busy (when a command is reading).

## Filesystem invariants

- **Sync API, async persistence.** `VirtualFS` keeps the whole disk in memory, so
  reads and writes are synchronous (builtins and Tab completion depend on that).
  Mutations queue changes; `await fs.flush()` saves them in one atomic IndexedDB
  transaction. The shell flushes after every command, and uploads flush per file. If a
  flush fails, the queued changes are rolled back in memory and `FsError` is thrown
  (`ENOSPC` for quota, `EIO` otherwise), so memory always matches storage.
- A builtin that wants to handle a save failure itself flushes explicitly (`curl -o`
  does, to exit 23); otherwise the shell reports it after the command.
- Mutating methods (`writeFile`, `mkdir`, `remove`, `rename`, `touch`) validate
  everything before changing anything, so a throwing call queues nothing. Keep new ones that way, and route all changes through `set()`.
- File content is `string | Uint8Array` (`FileContent`). Valid UTF-8 stays a string
  (`fromBytes()`). `readFile()` is the text view (binary is decoded lossily);
  `readBytes()`/`isBinary()` exist for byte-exact work. `FileNode.size` is bytes; use
  it, not `content.length`. Pipes and redirects carry text only.
- IndexedDB layout: database `onno` v1, store `nodes`, key = path. Schema changes need
  a version bump plus an `onupgradeneeded` migration. `onno:settings` stays in
  localStorage.
- Startup is async: `App.tsx` opens the disk with React 19's `use()` under `<Suspense>`,
  migrates `onno:fs:v1` from localStorage once, and falls back to `MemoryBackend`
  (with a notice) if IndexedDB is unavailable.
- Tests use `VirtualFS.open(new MemoryBackend(quotaBytes?), { seed })`. A quota makes
  commits fail like a full browser. `IndexedDBBackend` is tested with `fake-indexeddb`
  (a dev dependency); pass its `IDBFactory` to `IndexedDBBackend.open(name, factory)`.

## Testing

- Shell-level tests build a `Shell` on a `VirtualFS(new MemoryStore(), key, seed)` and
  call `shell.run(line, { stdout, stderr })`. Copy the `run()` helper from an existing
  test file.
- curl tests use a real local `Bun.serve`, not mocks. **Bun's fetch doesn't enforce
  CORS**, so anything CORS-related can only be checked in a real browser.
- When a test fails, check whether the expectation was wrong before changing the code.
  Hand-written expected output has been wrong here several times.

## Checking in a real browser

**A dev server may already be running on port 3000** (the user's `bun dev`). Don't
stop it. Run your own on another port (`PORT=3456 bun src/index.ts`; Bun's `serve()`
honours `PORT`), and stop it by PID (`lsof -t -i :3456`). Never `pkill -f` with a
pattern that appears in your own command line: it kills your shell.

There's no Playwright package, but its browsers are cached at
`~/.cache/ms-playwright/` (`chromium_headless_shell-*`). Launch
`chrome-headless-shell --remote-debugging-port=N` and drive it over the DevTools
protocol from a Bun script:
- `Input.insertText` plus an Enter key event to type commands
- `DOM.setFileInputFiles` to upload files
- `Page.captureScreenshot` to take screenshots

Firefox (`/usr/bin/firefox`) can only take static screenshots
(`firefox --headless --screenshot out.png URL`); to see UI state, render it to static
HTML first. Put such scripts in the session scratchpad, not the repo.

## Known browser constraints (don't try to "fix" these)

- Ctrl+W can't be intercepted in a normal tab; the handler only works in installed-app
  windows. Ctrl+Backspace already deletes words natively.
- curl only reaches same-origin or CORS-enabled URLs, and failures can't be told apart
  (unreachable host vs. CORS). An https deployment can't fetch http:// URLs.
- `navigator.storage.estimate()` is approximate (it may be padded) and covers all of
  the site's storage, so `df` usage won't exactly equal the disk's size.
- Each tab holds its own in-memory copy of the disk. Writes are per path, last writer
  wins, and other tabs don't see changes until they reload.

## Top pane: `mon` and `preview`

- `App.tsx` holds one `pane` state (`editor` or `preview`). `ShellHost.openEditor` /
  `openPreview` set it; an editor with unsaved changes blocks opening anything else.
  Every open gets a new `token`: the editor re-focuses, the preview remounts (re-reads).
- Both render inside `<Pane>`. CSS classes are generic (`.pane`, `.pane-titlebar`,
  `.pane-actions`, `.pane-status`...); the terminal won't steal focus from `.pane`.
- `preview` builds a `blob:` URL from `fs.readBytes()` inside an effect that also
  revokes it, which is safe under StrictMode's double run. Images are `<img>`, so SVG
  scripts never run.
- Testing: chrome-headless-shell has **no PDF viewer** (`navigator.pdfViewerEnabled`
  is false, so the pane shows its fallback message). To check real PDF rendering, load
  the PDF via a `blob:` iframe on a static page and screenshot it with headless
  Firefox (pdf.js). In flex/grid layouts, use flex for media so `max-height: 100%`
  resolves; in a grid cell it doesn't.

## AssemblyScript (`asc`)

- `asc` passes `ctx.args` straight to `asc.main()`, as `bin/asc.js` does, with exit
  status 1 on error. Don't parse or reinterpret the options; the compiler owns them
  (including `--help`, `--config`, `--target`).
- The compiler runs in a module Web Worker (`/asc/asc.worker.js`, ~21 MB). Its file
  callbacks are async: the worker sends disk requests to the main thread
  (`client.ts`), which answers from the VirtualFS. Ctrl+C terminates the worker; the
  next run starts a new one.
- **Worker gotcha:** `assemblyscript/asc` uses top-level await. A worker that imports it
  statically doesn't set `onmessage` until it has loaded, and messages posted
  meanwhile are silently dropped. Set the handler first and `await import(...)` inside
  it (see `worker.ts`). The worker then posts `{ type: "ready" }`, and `client.ts` only
  sends work after that. A worker that isn't ready within 20 s is reported as an
  error, never waited on forever.
- **Stale workers in dev:** `bun --hot` only reloads modules the server imports, and
  worker sources are built from a path, so they used to stay stale until a restart
  (that's what made `asc` hang). `src/index.ts` now watches `src/` in development and
  rebuilds a worker on its next request after any change, served with
  `Cache-Control: no-cache`. If a worker misbehaves, compare what the server serves
  with a fresh `buildWorker()` before debugging the code.
- **Bundle gotcha:** no `import("assemblyscript/asc")` may be reachable from app code,
  or Bun bundles the compiler into the app (and fails on its Node built-ins). The
  builtin gets its runner from `setAscRunner()` (default: the worker client); tests
  call `setAscRunner(runAscInProcess)` from `asc/inprocess.ts`.
- asc imports Node built-ins (`fs`, `module`, ...) behind a "running in Node?" check.
  `Bun.build` for the browser rejects them, so `src/workers.ts` marks them `external`.
- Binary on stdout (`-o` with no file name) is refused with a message, because shell
  output is text.

## Running WebAssembly (`wasm`)

- `run.ts` works on any thread. The builtin uses a fresh worker per run in the browser
  (`/wasm/run.worker.js`; Ctrl+C terminates it) and calls `runWasm` in-process
  elsewhere (tests). It has no heavy dependencies, so no runner injection is needed.
- The shell runs a file that starts with `\0asm` through the `wasm` builtin
  (`Shell.isWasmFile`), so `./x.wasm FUNC ARGS` and `.wasm` files on `$PATH` work.
- **Start functions:** AssemblyScript top-level code is the module's start function,
  which runs inside `WebAssembly.instantiate()`, before the instance's memory is
  available, so `console.log` couldn't read its string. `deferStart()` rewrites the
  binary (drops the start section, exports the function as `__onno_start`), and the
  runner calls it after instantiation. Keep that export hidden from listings.
- AssemblyScript strings: the pointer is to UTF-16LE data, and the byte length is the
  u32 just before it.
- Argument types come from `inspectWasm()` (the JS API doesn't expose them). Options
  are only recognised before FILE, so `-5` after it is an argument.

## Monaco editor (`mon`)

- `mon` validates the file and calls `shell.host.openEditor(path)`, then returns at
  once: editing doesn't block the shell. `App.tsx` holds the open file; `EditorPane`
  loads it, saves with `fs.writeFile` + `await fs.flush()`, and detects outside
  changes by comparing mtimes. Only one file is open at a time.
- Monaco is imported dynamically (`await import("./monaco")`) so it stays out of the
  initial bundle; `bun run build` uses `--splitting` for that.
- **Workers:** Bun's bundler leaves `new Worker(new URL("…", import.meta.url))` as a
  `file://` URL, which the browser refuses. So `src/workers.ts` bundles each worker
  with `Bun.build`, keyed by URL path. `src/index.ts` serves them from memory, and
  `scripts/build-workers.ts` writes them into `dist/`. Load them with
  `new URL("monaco/…", document.baseURI)`. Import worker paths through the package's
  `exports` map (`monaco-editor/language/json/json.worker`), not `esm/vs/…`.
- The browser's confirm dialogs aren't used: confirmations (unsaved changes, file
  changed on disk) live in the editor's title bar. `beforeunload` warns about unsaved
  edits.
- The fixed toolbar overlaps the right end of the pane title bar. The title bar
  reserves padding for it, so keep them aligned (56px bar, toolbar centred in it).
- **Testing Monaco in headless Chromium:** it uses the EditContext API (focused element
  `.native-edit-context`), not a `<textarea>`. Click into `.view-lines` with
  `Input.dispatchMouseEvent`, then type with `Input.dispatchKeyEvent` (`keyDown` with
  `text`; Enter needs `text: "\r"`). Monaco renders spaces as U+00A0, so normalise
  `textContent` before comparing.

## UI notes

- Themes: tokens on `:root`, overridden under `:root[data-theme="light"]`. The settings
  provider sets `data-theme` and `--font-size` on `<html>`.
- `[hidden] { display: none !important }` is required, because `display: flex` rules
  otherwise beat the `hidden` attribute.
- Firefox gives `<input type="range">` a wider natural width than Chromium. Inside flex
  or grid layouts, give it `width: 0; flex: 1` and use `minmax(0, 1fr)` columns, or it
  overflows its container. Check layout changes in both browsers.
- The terminal disables its input while a command runs. Keys needed during a run, like
  Ctrl+C, are caught on `window`. When a command finishes, the terminal refocuses its
  input unless focus is inside `.editor-pane`.
- Other components write to the terminal through the `TerminalHandle` ref
  (`print(kind, text)`).
