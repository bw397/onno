import { Suspense, use, useRef, useState } from "react";
import { createBuiltinRegistry } from "./builtins";
import { IndexedDBBackend, LEGACY_STORAGE_KEY, MemoryBackend, readLegacyDisk, VirtualFS } from "./fs";
import { SettingsMenu, SettingsProvider } from "./settings";
import { Shell } from "./shell";
import { Terminal, type TerminalHandle } from "./terminal/Terminal";
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
    <>
      <div className="toolbar">
        <UploadButton onFiles={onFiles} disabled={uploading} />
        <SettingsMenu />
      </div>
      <Terminal ref={terminal} shell={shell} banner={BANNER + (disk.notice ?? "")} />
    </>
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
