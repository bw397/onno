import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { complete, type Shell } from "../shell";
import { deleteWordBackward } from "./lineEditing";

type Entry =
  | { id: number; kind: "input"; prompt: string; text: string }
  | { id: number; kind: "stdout" | "stderr"; text: string };

let nextId = 0;

/** Show a path with the home directory as ~, like the prompt does. */
export function tildePath(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
}

function promptFor(shell: Shell): string {
  return `${shell.env.USER ?? "user"}@onno:${tildePath(shell.cwd, shell.env.HOME)}$`;
}

/** Lets the rest of the app (e.g. the upload button) write into the terminal. */
export interface TerminalHandle {
  print(kind: "stdout" | "stderr", text: string): void;
  focus(): void;
}

export function Terminal({ shell, banner, ref }: { shell: Shell; banner?: string; ref?: Ref<TerminalHandle> }) {
  const [entries, setEntries] = useState<Entry[]>(() =>
    banner ? [{ id: nextId++, kind: "stdout", text: banner }] : [],
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState(() => promptFor(shell));
  const history = useRef<string[]>([]);
  const historyIndex = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Cursor position to apply after the next input change (set by completion). */
  const pendingCursor = useRef<number | null>(null);
  /** The line as of the previous Tab press, if the last key was Tab; for double-Tab listing. */
  const lastTabLine = useRef<string | null>(null);

  /** Aborts the running command; set while busy. */
  const abortRef = useRef<AbortController | null>(null);

  // The input is disabled while a command runs, so listen for Ctrl+C on the window.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey && e.key === "c") || window.getSelection()?.toString()) return;
      e.preventDefault();
      if (abortRef.current && !abortRef.current.signal.aborted) {
        abortRef.current.abort();
        write("stdout", "^C\n");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && pendingCursor.current !== null) {
      el.setSelectionRange(pendingCursor.current, pendingCursor.current);
      pendingCursor.current = null;
    }
  }, [input]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, busy]);

  // Refocus the prompt when a command finishes, unless focus is in the top pane (e.g. `mon`
  // just opened the editor).
  useEffect(() => {
    if (!busy && !document.activeElement?.closest(".pane")) inputRef.current?.focus();
  }, [busy]);

  // Stay scrolled to the bottom when the terminal is resized (e.g. the editor opens).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Append output, merging with the previous entry when it's the same stream. */
  const write = useCallback((kind: "stdout" | "stderr", text: string) => {
    if (!text) return;
    setEntries((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === kind) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: nextId++, kind, text }];
    });
  }, []);

  useImperativeHandle(ref, () => ({ print: write, focus: () => inputRef.current?.focus() }), [write]);

  const submit = async (line: string) => {
    setEntries((prev) => [...prev, { id: nextId++, kind: "input", prompt, text: line }]);
    setInput("");
    if (line.trim()) {
      if (history.current[history.current.length - 1] !== line) history.current.push(line);
    }
    historyIndex.current = history.current.length;
    if (!line.trim()) return;

    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await shell.run(line, {
        stdout: (s) => write("stdout", s),
        stderr: (s) => write("stderr", s),
        signal: controller.signal,
      });
    } catch (err) {
      write("stderr", `onno: internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      abortRef.current = null;
      setPrompt(promptFor(shell));
      setBusy(false);
    }
  };

  const onTab = (el: HTMLInputElement) => {
    const cursor = el.selectionStart ?? input.length;
    const result = complete(shell, input, cursor);
    const isDoubleTab = lastTabLine.current === input;
    lastTabLine.current = result.line;

    if (result.line !== input) {
      pendingCursor.current = result.cursor;
      setInput(result.line);
    } else if (result.candidates.length && isDoubleTab) {
      // Second Tab with nothing more to insert: list the options, like bash.
      setEntries((prev) => [
        ...prev,
        { id: nextId++, kind: "input", prompt, text: input },
        { id: nextId++, kind: "stdout", text: result.candidates.join("  ") + "\n" },
      ]);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") {
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault(); // keep focus in the terminal
      onTab(e.currentTarget);
      return;
    }
    lastTabLine.current = null;

    if (e.key === "Enter") {
      e.preventDefault();
      void submit(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historyIndex.current > 0) {
        historyIndex.current--;
        setInput(history.current[historyIndex.current] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex.current < history.current.length) {
        historyIndex.current++;
        setInput(history.current[historyIndex.current] ?? "");
      }
    } else if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "w") {
      // Note: most browsers reserve Ctrl+W (close tab) and never deliver it to the
      // page; this runs where they don't (e.g. installed app windows).
      e.preventDefault();
      const el = e.currentTarget;
      const next = deleteWordBackward({ line: input, cursor: el.selectionStart ?? input.length });
      pendingCursor.current = next.cursor;
      setInput(next.line);
    } else if (e.ctrlKey && e.key === "l") {
      e.preventDefault();
      setEntries([]);
    } else if (e.ctrlKey && e.key === "c") {
      // Only cancel the line when nothing is selected, so copying still works.
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      setEntries((prev) => [...prev, { id: nextId++, kind: "input", prompt, text: input + "^C" }]);
      setInput("");
    }
  };

  // Focus the input on click, unless the user is selecting text.
  const onClick = () => {
    if (!window.getSelection()?.toString()) inputRef.current?.focus();
  };

  return (
    <div className="terminal" ref={scrollRef} onClick={onClick}>
      {entries.map((e) =>
        e.kind === "input" ? (
          <div key={e.id} className="line">
            <span className="prompt">{e.prompt}</span> {e.text}
          </div>
        ) : (
          <pre key={e.id} className={`output ${e.kind}`}>
            {e.text.endsWith("\n") ? e.text.slice(0, -1) : e.text}
          </pre>
        ),
      )}
      <div className="line input-line" hidden={busy}>
        <span className="prompt">{prompt}</span>
        <input
          ref={inputRef}
          className="term-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label="Command input"
        />
      </div>
    </div>
  );
}
