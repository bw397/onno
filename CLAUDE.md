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
   `man.test.ts` fails if any is missing. It also *runs every example* against the
   default seeded disk, so examples must parse, use real commands, and not hit usage
   errors. Examples that need the network belong to `curl`, which is excluded.
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

## Filesystem invariants

- **Sync API, async persistence.** `VirtualFS` keeps the whole disk in memory, so
  reads and writes are synchronous (builtins and Tab completion depend on that).
  Mutations queue changes; `await fs.flush()` saves them in one atomic IndexedDB
  transaction. The shell flushes after every command, and uploads flush per file. If a
  flush fails, the queued changes are rolled back in memory and `FsError` is thrown
  (`ENOSPC` for quota, `EIO` otherwise), so memory always matches storage.
- A builtin that wants to handle a save failure itself flushes explicitly (`curl -o`
  does, to exit 23); otherwise the shell reports it after the command.
- Mutating methods validate everything before changing anything, so a throwing call
  queues nothing. Keep new ones that way, and route all changes through `set()`.
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

## Monaco editor (`mon`)

- `mon` validates the file and calls `shell.host.openEditor(path)`, then returns at
  once: editing doesn't block the shell. `App.tsx` holds the open file; `EditorPane`
  loads it, saves with `fs.writeFile` + `await fs.flush()`, and detects outside
  changes by comparing mtimes. Only one file is open at a time.
- Monaco is imported dynamically (`await import("./monaco")`) so it stays out of the
  initial bundle; `bun run build` uses `--splitting` for that.
- **Workers:** Bun's bundler leaves `new Worker(new URL("…", import.meta.url))` as a
  `file://` URL, which the browser refuses. So `src/editor/workers.ts` bundles each
  worker with `Bun.build`. `src/index.ts` serves them from memory at
  `/monaco/<name>.worker.js`, and `scripts/build-workers.ts` writes them to
  `dist/monaco/`. Import worker paths through the package's `exports` map
  (`monaco-editor/language/json/json.worker`), not `esm/vs/…`.
- The browser's confirm dialogs aren't used: confirmations (unsaved changes, file
  changed on disk) live in the editor's title bar. `beforeunload` warns about unsaved
  edits.
- The fixed toolbar overlaps the right end of the editor title bar. The title bar
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
