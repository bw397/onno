import { describe, expect, test } from "bun:test";
import { deleteWordBackward } from "./lineEditing";

/** Run on a line with `█` marking the cursor; return the result in the same form. */
function rubout(marked: string): string {
  const cursor = marked.indexOf("█");
  const r = deleteWordBackward({ line: marked.replace("█", ""), cursor });
  return r.line.slice(0, r.cursor) + "█" + r.line.slice(r.cursor);
}

describe("deleteWordBackward", () => {
  test("deletes the previous word", () => {
    expect(rubout("cat foo.txt█")).toBe("cat █");
    expect(rubout("cat █")).toBe("█");
  });

  test("whitespace-delimited, so punctuation and paths go together", () => {
    expect(rubout("ls /home/user/docs█")).toBe("ls █");
    expect(rubout("a && b█")).toBe("a && █");
  });

  test("skips trailing whitespace first", () => {
    expect(rubout("echo hello   █")).toBe("echo █");
  });

  test("mid-line keeps text after the cursor", () => {
    expect(rubout("cat foo█ bar")).toBe("cat █ bar");
    expect(rubout("cat fo█o")).toBe("cat █o");
  });

  test("at the start or on an empty line does nothing", () => {
    expect(rubout("█abc")).toBe("█abc");
    expect(rubout("█")).toBe("█");
  });
});
