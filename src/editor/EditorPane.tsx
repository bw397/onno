import { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { FsError, path as fsPath, type VirtualFS } from "../fs";
import { Pane } from "../pane/Pane";
import { useSettings } from "../settings";

type MonacoModule = typeof import("./monaco");

/** A confirmation shown in the title bar (the viewer has no confirm() dialogs to rely on). */
type Prompt = "close" | "conflict" | null;

export interface EditorPaneProps {
  fs: VirtualFS;
  /** Absolute path of the file being edited (may not exist yet). */
  path: string;
  /** Changes whenever the editor should take focus (e.g. `mon` on the open file). */
  focusToken: number;
  /** How to show a path to the user (e.g. with ~ for home). */
  displayPath: (path: string) => string;
  onClose(): void;
  onDirtyChange(dirty: boolean): void;
  /** Write a line to the terminal. */
  print(kind: "stdout" | "stderr", text: string): void;
}

export function EditorPane({ fs, path, focusToken, displayPath, onClose, onDirtyChange, print }: EditorPaneProps) {
  const { settings } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  /** mtime of the file when loaded or last saved (null = didn't exist), to detect outside changes. */
  const baseMtime = useRef<number | null>(null);
  /** Model version at the last save; differs from the current one when there are unsaved edits. */
  const savedVersion = useRef(0);

  const [state, setState] = useState<"loading" | "ready" | { error: string }>("loading");
  const [dirty, setDirty] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const name = displayPath(path);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  /** Load the file into the model and mark it clean. */
  const loadFromDisk = useCallback(() => {
    const editor = editorRef.current;
    const node = fs.stat(path);
    const text = node?.type === "file" ? fs.readFile(path) : "";
    baseMtime.current = node?.mtime ?? null;
    editor?.getModel()?.setValue(text);
    savedVersion.current = editor?.getModel()?.getAlternativeVersionId() ?? 0;
    setDirty(false);
  }, [fs, path]);

  const save = useCallback(
    async (force = false): Promise<boolean> => {
      const model = editorRef.current?.getModel();
      if (!model) return false;
      const current = fs.stat(path)?.mtime ?? null;
      if (!force && current !== baseMtime.current) {
        setPrompt("conflict"); // changed (or created/deleted) outside the editor since loading
        return false;
      }
      try {
        fs.writeFile(path, model.getValue());
        await fs.flush();
      } catch (err) {
        const message = err instanceof FsError || err instanceof Error ? err.message : String(err);
        setNotice({ kind: "error", text: message });
        print("stderr", `mon: ${name}: ${message}\n`);
        return false;
      }
      const node = fs.stat(path);
      baseMtime.current = node?.mtime ?? null;
      savedVersion.current = model.getAlternativeVersionId();
      setDirty(false);
      setPrompt(null);
      setNotice({ kind: "info", text: "Saved" });
      print("stdout", `mon: saved ${name} (${node?.type === "file" ? node.size : 0} bytes)\n`);
      return true;
    },
    [fs, path, name, print],
  );

  // Monaco keybindings are registered once, so they call the latest save through a ref.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Create the editor (loading Monaco on first use).
  useEffect(() => {
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
    let model: Monaco.editor.ITextModel | undefined;
    (async () => {
      const mod = (monacoRef.current ??= await import("./monaco"));
      if (disposed || !containerRef.current) return;
      const { monaco, languageFor } = mod;
      const node = fs.stat(path);
      baseMtime.current = node?.mtime ?? null;
      model = monaco.editor.createModel(
        node?.type === "file" ? fs.readFile(path) : "",
        languageFor(fsPath.basename(path)),
        monaco.Uri.file(path),
      );
      editor = monaco.editor.create(containerRef.current, {
        model,
        theme: settings.theme === "dark" ? "onno-dark" : "onno-light",
        fontSize: settings.fontSize,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
      });
      editorRef.current = editor;
      savedVersion.current = model.getAlternativeVersionId();
      model.onDidChangeContent(() => {
        setDirty(model!.getAlternativeVersionId() !== savedVersion.current);
        setNotice(null);
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
      editor.focus();
      setState("ready");
    })().catch((err) => setState({ error: err instanceof Error ? err.message : String(err) }));

    return () => {
      disposed = true;
      editor?.dispose();
      model?.dispose();
      editorRef.current = null;
    };
    // Settings are applied by the effect below; recreating the editor would lose edits.
  }, [fs, path]);

  // Follow the app's theme and font size.
  useEffect(() => {
    monacoRef.current?.monaco.editor.setTheme(settings.theme === "dark" ? "onno-dark" : "onno-light");
    editorRef.current?.updateOptions({ fontSize: settings.fontSize });
  }, [settings.theme, settings.fontSize, state]);

  useEffect(() => {
    editorRef.current?.focus();
  }, [focusToken]);

  // Unsaved edits: let the browser warn before the page is closed or reloaded.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const requestClose = () => (dirty ? setPrompt("close") : onClose());

  const cancelPrompt = () => {
    setPrompt(null);
    editorRef.current?.focus();
  };

  return (
    <Pane
      label={`Editing ${name}`}
      title={name}
      titleTooltip={path}
      titleExtra={dirty && <span className="editor-dirty" aria-label="unsaved changes" title="Unsaved changes" />}
      onClose={requestClose}
      onKeyDown={(e) => {
        if (e.key === "Escape" && prompt) {
          e.preventDefault();
          cancelPrompt();
        }
      }}
      middle={
        <>
          {prompt === "close" && (
            <span className="pane-prompt" role="alert">
              Unsaved changes.
              <button type="button" onClick={async () => (await save()) && onClose()}>Save and close</button>
              <button type="button" className="danger" onClick={onClose}>Discard</button>
              <button type="button" onClick={cancelPrompt}>Cancel</button>
            </span>
          )}
          {prompt === "conflict" && (
            <span className="pane-prompt" role="alert">
              Changed on disk since you opened it.
              <button type="button" className="danger" onClick={() => void save(true)}>Overwrite</button>
              <button type="button" onClick={() => { loadFromDisk(); cancelPrompt(); }}>Reload</button>
              <button type="button" onClick={cancelPrompt}>Cancel</button>
            </span>
          )}
          {!prompt && notice && <span className={`pane-notice ${notice.kind}`}>{notice.text}</span>}
        </>
      }
      actions={
        <button type="button" onClick={() => void save()} disabled={state !== "ready"} title="Save (Ctrl+S)">
          Save
        </button>
      }
    >
      {state === "loading" && <div className="pane-status">Loading editor…</div>}
      {typeof state === "object" && <div className="pane-status error">Couldn't load the editor: {state.error}</div>}
      <div ref={containerRef} className="editor-monaco" />
    </Pane>
  );
}
