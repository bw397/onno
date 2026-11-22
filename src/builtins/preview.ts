import { FsError } from "../fs";
import { detectViewable, isPlainText } from "../preview/viewable";
import type { Builtin } from "../shell";
import { formatSize } from "../upload";

export const preview: Builtin = {
  name: "preview",
  summary: "view an image, PDF, audio or video file",
  usage: "preview FILE",
  description:
    "Show FILE in the top of the screen, with the terminal still usable below it, the " +
    "same way mon opens the editor. Images (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG) " +
    "can be fitted to the pane or shown at actual size; PDFs open in the browser's PDF " +
    "viewer; audio and video get playback controls. The file type is detected from its " +
    "contents, so misnamed files still work. Close with the title bar's close button or " +
    "Esc; Download saves a copy to your computer. Running preview on the file again " +
    "refreshes it.",
  examples: [
    { command: "preview photo.jpg", description: "View an image (e.g. one you uploaded)." },
    {
      command: `echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="tomato"/></svg>' > dot.svg && preview dot.svg`,
      description: "Draw an SVG with echo, then view it.",
    },
    { command: "preview manual.pdf", description: "Read a PDF." },
    { command: "find . -name '*.png'", description: "Find images to preview." },
  ],
  run(ctx) {
    if (ctx.args.length !== 1) {
      ctx.stderr(`preview: expected one file\nusage: ${preview.usage}\n`);
      return 2;
    }
    const file = ctx.args[0]!;
    const abs = ctx.resolvePath(file);

    let bytes: Uint8Array;
    try {
      bytes = ctx.fs.readBytes(abs);
    } catch (err) {
      if (!(err instanceof FsError)) throw err;
      ctx.stderr(`preview: ${file}: ${err.message}\n`);
      return 1;
    }
    const view = detectViewable(file, bytes);
    if (!view) {
      const hint = bytes.length === 0 ? "it's empty" : isPlainText(bytes) ? "it's text; try cat or mon" : "unknown file type";
      ctx.stderr(`preview: ${file}: can't preview this file (${hint})\n`);
      return 1;
    }

    const host = ctx.shell.host;
    if (!host) {
      ctx.stderr("preview: no viewer is available here\n");
      return 1;
    }
    const error = host.openPreview(abs);
    if (error) {
      ctx.stderr(`preview: ${error}\n`);
      return 1;
    }
    ctx.stdout(`preview: showing ${abs} (${view.mime}, ${formatSize(bytes.byteLength)})\n`);
    return 0;
  },
};
