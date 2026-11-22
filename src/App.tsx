import { useRef, useState } from "react";
import { createBuiltinRegistry } from "./builtins";
import { MemoryStore, VirtualFS, type KeyValueStore } from "./fs";
import { SettingsMenu, SettingsProvider } from "./settings";
import { Shell } from "./shell";
import { Terminal, type TerminalHandle } from "./terminal/Terminal";
import { formatSize, UploadButton, uploadFiles } from "./upload";
import "./index.css";

function browserStore(): KeyValueStore {
  try {
    localStorage.setItem("onno:probe", "1");
    localStorage.removeItem("onno:probe");
    return localStorage;
  } catch {
    return new MemoryStore(); // private mode / storage disabled
  }
}

function createShell(): Shell {
  const fs = new VirtualFS(browserStore());
  return new Shell(fs, createBuiltinRegistry());
}

const BANNER = "onno shell. Try `cat welcome.txt` or `ls -l /`.\n";

export function App() {
  const [shell] = useState(createShell);
  const terminal = useRef<TerminalHandle>(null);
  const [uploading, setUploading] = useState(false);

  const onFiles = async (files: File[]) => {
    setUploading(true);
    try {
      for (const r of await uploadFiles(shell.fs, shell.cwd, files)) {
        if (r.ok) {
          const note = r.renamed ? " (renamed: name was taken)" : "";
          terminal.current?.print("stdout", `upload: ${r.name} -> ${r.path} (${formatSize(r.size)})${note}\n`);
        } else {
          terminal.current?.print("stderr", `upload: ${r.name}: ${r.error}\n`);
        }
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <SettingsProvider>
      <div className="toolbar">
        <UploadButton onFiles={onFiles} disabled={uploading} />
        <SettingsMenu />
      </div>
      <Terminal ref={terminal} shell={shell} banner={BANNER} />
    </SettingsProvider>
  );
}

export default App;
