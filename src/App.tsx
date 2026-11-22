import { Suspense, use, useCallback, useEffect, useRef, useState } from "react";
import { EditorPane } from "./editor/EditorPane";
import { PreviewPane } from "./preview/PreviewPane";
import { createBuiltinRegistry } from "./builtins";
import { IndexedDBBackend, LEGACY_STORAGE_KEY, MemoryBackend, readLegacyDisk, VirtualFS } from "./fs";
import { SettingsMenu, SettingsProvider } from "./settings";
import { Shell } from "./shell";
import { tildePath, Terminal, type TerminalHandle } from "./terminal/Terminal";
import { formatSize, UploadButton, uploadFiles } from "./upload";
import "./index.css";

interface Disk {
  fs: VirtualFS;
  /** Shown in the terminal at startup, e.g. when storage is unavailable. */
  notice?: string;
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by browser settings
  }
}

async function openDisk(): Promise<Disk> {
  const storage = safeLocalStorage();
  let migrated = false;
  try {
    const fs = await VirtualFS.open(await IndexedDBBackend.open(), {
      // Bring over a disk saved by the localStorage version of the app.
      migrate: () => (storage ? readLegacyDisk(storage) : null),
      onMigrated: () => {
        migrated = true;
        storage?.removeItem(LEGACY_STORAGE_KEY);
      },
    });
    return { fs, notice: migrated ? "onno: moved your disk from localStorage to IndexedDB.\n" : undefined };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      fs: await VirtualFS.open(new MemoryBackend()),
      notice: `onno: IndexedDB is unavailable (${reason}); this session's disk won't be saved.\n`,
    };
  }
}

// Opened once per page load (and shared across StrictMode's double render).
let diskPromise: Promise<Disk> | undefined;
const getDisk = () => (diskPromise ??= openDisk());

const BANNER = "onno shell. Try `cat welcome.txt`, `ls -l /` or `man -k .`.\n";

function Workspace() {
  const disk = use(getDisk());
  const [shell] = useState(() => new Shell(disk.fs, createBuiltinRegistry()));
  const terminal = useRef<TerminalHandle>(null);
  const [uploading, setUploading] = useState(false);

  // What's open in the top pane, if anything. `token` changes on every open, so opening
  // the same file again re-focuses the editor or refreshes the preview.
  const [pane, setPane] = useState<{ kind: "editor" | "preview"; path: string; token: number } | null>(null);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const dirtyRef = useRef(false); // the editor has unsaved changes

  // Let `mon` and `preview` open the top pane (one thing at a time).
  useEffect(() => {
    const open = (kind: "editor" | "preview", path: string): string | null => {
      const current = paneRef.current;
      const sameEditor = current?.kind === "editor" && kind === "editor" && current.path === path;
      if (current?.kind === "editor" && dirtyRef.current && !sameEditor) {
        return `${tildePath(current.path, shell.env.HOME)} has unsaved changes; save or close it first`;
      }
      if (!sameEditor) dirtyRef.current = false;
      setPane({ kind, path, token: (current?.token ?? 0) + 1 });
      return null;
    };
    shell.host = {
      openEditor: (path) => open("editor", path),
      openPreview: (path) => open("preview", path),
    };
    return () => {
      shell.host = undefined;
    };
  }, [shell]);

  const closePane = useCallback(() => {
    dirtyRef.current = false;
    setPane(null);
    terminal.current?.focus();
  }, []);
  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  const print = useCallback((kind: "stdout" | "stderr", text: string) => terminal.current?.print(kind, text), []);
  const displayPath = useCallback((p: string) => tildePath(p, shell.env.HOME), [shell]);

  const onFiles = async (files: File[]) => {
    setUploading(true);
    try {
      for (const r of await uploadFiles(shell.fs, shell.cwd, files)) {
        if (r.ok) {
          const notes = [formatSize(r.size), r.binary && "binary", r.renamed && "renamed: name was taken"];
          terminal.current?.print("stdout", `upload: ${r.name} -> ${r.path} (${notes.filter(Boolean).join(", ")})\n`);
        } else {
          terminal.current?.print("stderr", `upload: ${r.name}: ${r.error}\n`);
        }
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="workspace">
      {pane?.kind === "editor" && (
        <EditorPane
          key={`editor:${pane.path}`}
          fs={shell.fs}
          path={pane.path}
          focusToken={pane.token}
          displayPath={displayPath}
          onClose={closePane}
          onDirtyChange={onDirtyChange}
          print={print}
        />
      )}
      {pane?.kind === "preview" && (
        <PreviewPane key={`preview:${pane.token}`} fs={shell.fs} path={pane.path} displayPath={displayPath} onClose={closePane} />
      )}
      <div className="toolbar">
        <UploadButton onFiles={onFiles} disabled={uploading} />
        <SettingsMenu />
      </div>
      <Terminal ref={terminal} shell={shell} banner={BANNER + (disk.notice ?? "")} />
    </div>
  );
}

export function App() {
  return (
    <SettingsProvider>
      <Suspense fallback={<div className="terminal loading">Loading disk…</div>}>
        <Workspace />
      </Suspense>
    </SettingsProvider>
  );
}

export default App;
