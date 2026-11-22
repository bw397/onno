import { useEffect, useRef, useState } from "react";
import { FsError, path as fsPath, type VirtualFS } from "../fs";
import { Pane } from "../pane/Pane";
import { formatSize } from "../upload";
import { detectViewable, type Viewable } from "./viewable";

export interface PreviewPaneProps {
  fs: VirtualFS;
  /** Absolute path of the file to show. */
  path: string;
  /** How to show a path to the user (e.g. with ~ for home). */
  displayPath: (path: string) => string;
  onClose(): void;
}

type Loaded = { url: string; view: Viewable; size: number } | { error: string };

/** Read the file and make a blob: URL the browser can display. */
function load(fs: VirtualFS, path: string): Loaded {
  let bytes: Uint8Array;
  try {
    bytes = fs.readBytes(path);
  } catch (err) {
    return { error: err instanceof FsError ? err.message : String(err) };
  }
  const view = detectViewable(fsPath.basename(path), bytes);
  if (!view) return { error: "This kind of file can't be shown in the browser." };
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: view.mime }));
  return { url, view, size: bytes.byteLength };
}

/** Shows an image, PDF, audio or video file from the disk in the top pane. */
export function PreviewPane({ fs, path, displayPath, onClose }: PreviewPaneProps) {
  // The blob URL is created and revoked by the same effect, so StrictMode's double run
  // can't leave a revoked URL in use. Re-read on every mount: running `preview` on the
  // same file again remounts this and refreshes it.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    const result = load(fs, path);
    setLoaded(result);
    return () => {
      if ("url" in result) URL.revokeObjectURL(result.url);
    };
  }, [fs, path]);

  const [fit, setFit] = useState(true);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const paneRef = useRef<HTMLElement>(null);
  const name = displayPath(path);

  // Take focus so Esc works and the terminal doesn't grab it back.
  useEffect(() => paneRef.current?.focus(), []);

  const details =
    loaded && "url" in loaded ? [loaded.view.mime, formatSize(loaded.size), dimensions].filter(Boolean).join(" · ") : null;

  return (
    <Pane
      ref={paneRef}
      label={`Preview of ${name}`}
      title={name}
      titleTooltip={path}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      middle={details && <span className="pane-notice">{details}</span>}
      actions={
        loaded && "url" in loaded && (
          <>
            {loaded.view.kind === "image" && (
              <button type="button" onClick={() => setFit((f) => !f)} title={fit ? "Show at actual size" : "Fit to the pane"}>
                {fit ? "100%" : "Fit"}
              </button>
            )}
            <a className="pane-button" href={loaded.url} download={fsPath.basename(path)} title="Save a copy to your computer">
              Download
            </a>
          </>
        )
      }
    >
      {!loaded ? null : "error" in loaded ? (
        <div className="pane-status error">{loaded.error}</div>
      ) : mediaError ? (
        <div className="pane-status error">The browser couldn't display this file ({loaded.view.mime}); it may be damaged.</div>
      ) : loaded.view.kind === "image" ? (
        <div className={`preview-image ${fit ? "fit" : "actual"}`}>
          <img
            src={loaded.url}
            alt={name}
            onLoad={(e) => setDimensions(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
            onError={() => setMediaError(true)}
          />
        </div>
      ) : loaded.view.kind === "pdf" ? (
        // Browsers without a built-in PDF viewer would show an empty frame or start a download.
        navigator.pdfViewerEnabled === false ? (
          <div className="pane-status">This browser can't show PDFs inline. Use Download to open it with another app.</div>
        ) : (
          <iframe className="preview-frame" src={loaded.url} title={name} />
        )
      ) : loaded.view.kind === "audio" ? (
        <div className="preview-media">
          <audio controls src={loaded.url} onError={() => setMediaError(true)} />
        </div>
      ) : (
        <div className="preview-media">
          <video
            controls
            src={loaded.url}
            onLoadedMetadata={(e) => setDimensions(`${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`)}
            onError={() => setMediaError(true)}
          />
        </div>
      )}
    </Pane>
  );
}
