/** POSIX-style path helpers for the virtual filesystem. All results are absolute. */

export function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

/** Resolve `path` against `cwd` (if relative). */
export function resolve(cwd: string, path: string): string {
  return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
}

export function join(...parts: string[]): string {
  return normalize(parts.join("/"));
}

export function dirname(path: string): string {
  const p = normalize(path);
  if (p === "/") return "/";
  return p.slice(0, p.lastIndexOf("/")) || "/";
}

export function basename(path: string): string {
  const p = normalize(path);
  return p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1);
}
