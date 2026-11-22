import { describe, expect, test } from "bun:test";
import { detectViewable, isPlainText } from "./viewable";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const pad = (n: number) => new Array(n).fill(0);

describe("detectViewable: by content", () => {
  test.each([
    ["png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad(8)), "image", "image/png"],
    ["jpeg", bytes([0xff, 0xd8, 0xff, 0xe0], pad(8)), "image", "image/jpeg"],
    ["gif", bytes("GIF89a", pad(8)), "image", "image/gif"],
    ["webp", bytes("RIFF", pad(4), "WEBPVP8 "), "image", "image/webp"],
    ["avif", bytes(pad(4), "ftypavif", pad(4)), "image", "image/avif"],
    ["bmp", bytes("BM", pad(20)), "image", "image/bmp"],
    ["ico", bytes([0, 0, 1, 0], pad(8)), "image", "image/x-icon"],
    ["pdf", bytes("%PDF-1.7\n"), "pdf", "application/pdf"],
    ["wav", bytes("RIFF", pad(4), "WAVEfmt "), "audio", "audio/wav"],
    ["mp3 (ID3)", bytes("ID3", [4, 0], pad(8)), "audio", "audio/mpeg"],
    ["mp3 (frame)", bytes([0xff, 0xfb, 0x90], pad(8)), "audio", "audio/mpeg"],
    ["flac", bytes("fLaC", pad(8)), "audio", "audio/flac"],
    ["ogg audio", bytes("OggS", pad(24), [1], "vorbis"), "audio", "audio/ogg"],
    ["ogg video", bytes("OggS", pad(24), [0x80], "theora"), "video", "video/ogg"],
    ["m4a", bytes(pad(4), "ftypM4A ", pad(4)), "audio", "audio/mp4"],
    ["mp4", bytes(pad(4), "ftypisom", pad(4)), "video", "video/mp4"],
    ["mov", bytes(pad(4), "ftypqt  ", pad(4)), "video", "video/quicktime"],
    ["webm", bytes([0x1a, 0x45, 0xdf, 0xa3], pad(8)), "video", "video/webm"],
  ])("%s", (_, data, kind, mime) => {
    // The name is deliberately wrong: content wins.
    expect(detectViewable("misnamed.txt", data)).toEqual({ kind: kind as never, mime });
  });

  test("svg, with or without an XML prolog, comments and doctype", () => {
    const svg = { kind: "image", mime: "image/svg+xml" };
    expect(detectViewable("x", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual(svg as never);
    expect(detectViewable("x", bytes('<?xml version="1.0"?>\n<!-- hi -->\n<!DOCTYPE svg>\n<svg>'))).toEqual(svg as never);
    expect(detectViewable("x.svg", bytes("<html><svg></svg></html>"))).toBeNull(); // HTML, not an SVG file
  });
});

describe("detectViewable: fallback and refusal", () => {
  test("unknown binary content falls back to the extension", () => {
    expect(detectViewable("clip.mp4", bytes([0, 1, 2, 3, 0xff, 0xfe]))).toEqual({ kind: "video", mime: "video/mp4" });
  });

  test("text files, empty files and unknown types aren't previewable", () => {
    expect(detectViewable("notes.txt", bytes("hello"))).toBeNull();
    expect(detectViewable("fake.png", bytes("just text"))).toBeNull(); // text named .png
    expect(detectViewable("empty.png", new Uint8Array())).toBeNull();
    expect(detectViewable("archive.zip", bytes("PK", [3, 4], pad(10)))).toBeNull();
  });

  test("isPlainText", () => {
    expect(isPlainText(new TextEncoder().encode("héllo"))).toBe(true);
    expect(isPlainText(bytes([0xff, 0xfe]))).toBe(false);
    expect(isPlainText(bytes("a", [0], "b"))).toBe(false);
  });
});
