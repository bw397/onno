import { useRef } from "react";

/** Toolbar button that opens the OS file picker and hands back the chosen files. */
export function UploadButton({ onFiles, disabled }: { onFiles(files: File[]): void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label="Upload files to the current directory"
        title="Upload files to the current directory"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
          />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = ""; // allow picking the same file again
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
