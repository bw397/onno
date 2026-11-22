# CLAUDE.md

onno is a terminal in the browser: a small shell that runs builtin commands, or script
files from a virtual disk stored in `localStorage`. It uses Bun, React 19 and TypeScript
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
- `src/fs/`: `VirtualFS` (a path -> node map, saved as one JSON blob), `path.ts`, the
  first-run `seed.ts`, and `quota.ts` (localStorage usage/quota measurement).
- `src/terminal/`, `src/settings/`, `src/upload/`: the React UI. `App.tsx` wires
  them together.

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
5. Mirror GNU behaviour where it's cheap. For grep and find, the outputs were checked
   against the system's GNU tools; keep it that way.

## Filesystem invariants

- Every mutation goes through `VirtualFS.commit()`. If saving fails (localStorage
  `QuotaExceededError`), memory is rolled back and `FsError("ENOSPC")` is thrown, so
  memory and storage never disagree. Keep new mutating methods inside `commit()`.
- The disk stores **text only**. Uploads reject binary data; curl decodes bodies as
  UTF-8.
- localStorage keys: `onno:fs:v1` (the disk) and `onno:settings`. If the stored format
  changes, bump the version in the key; don't silently reinterpret old data.
- Tests use `MemoryStore`. Pass a quota (`new MemoryStore(1000)`) to simulate a full
  disk. It throws like the real localStorage does.

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
- No API reports localStorage quota; `df` probes it once per session (~10 ms in
  Chromium, ~200 ms in Firefox, about 5 MiB each). Each probe write fires `storage`
  events in other tabs.

## UI notes

- Themes: tokens on `:root`, overridden under `:root[data-theme="light"]`. The settings
  provider sets `data-theme` and `--font-size` on `<html>`.
- `[hidden] { display: none !important }` is required, because `display: flex` rules
  otherwise beat the `hidden` attribute.
- Firefox gives `<input type="range">` a wider natural width than Chromium. Inside flex
  or grid layouts, give it `width: 0; flex: 1` and use `minmax(0, 1fr)` columns, or it
  overflows its container. Check layout changes in both browsers.
- The terminal disables its input while a command runs. Keys needed during a run, like
  Ctrl+C, are caught on `window`.
- Other components write to the terminal through the `TerminalHandle` ref
  (`print(kind, text)`).
