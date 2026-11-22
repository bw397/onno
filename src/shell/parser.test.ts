import { describe, expect, test } from "bun:test";
import { ParseError, tokenize } from "./lexer";
import { parse } from "./parser";
import type { Token } from "./types";

/** Render tokens compactly: words as strings with $vars, ops as [op]. */
const show = (tokens: Token[]) =>
  tokens.map((t) =>
    t.type === "op" ? `[${t.value}]` : t.parts.map((p) => (p.kind === "literal" ? p.value : `\${${p.name}}`)).join(""),
  );

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(show(tokenize("  ls   -l  /tmp "))).toEqual(["ls", "-l", "/tmp"]);
  });

  test("quotes and escapes", () => {
    expect(show(tokenize(`cat 'a b' "c d" e\\ f ""`))).toEqual(["cat", "a b", "c d", "e f", ""]);
  });

  test("variables expand in double quotes but not single quotes", () => {
    expect(show(tokenize(`a $X "$Y-z" '$Z' \${W}x $? $1`))).toEqual([
      "a", "${X}", "${Y}-z", "$Z", "${W}x", "${?}", "${1}",
    ]);
  });

  test("leading tilde becomes $HOME", () => {
    expect(show(tokenize("ls ~ ~/docs a~b '~'"))).toEqual(["ls", "${HOME}", "${HOME}/docs", "a~b", "~"]);
  });

  test("operators", () => {
    expect(show(tokenize("a|b||c&&d;e>f>>g<h"))).toEqual([
      "a", "[|]", "b", "[||]", "c", "[&&]", "d", "[;]", "e", "[>]", "f", "[>>]", "g", "[<]", "h",
    ]);
  });

  test("comments and newlines", () => {
    expect(show(tokenize("# hi\nls # trailing\npwd"))).toEqual(["[;]", "ls", "[;]", "pwd"]);
    expect(show(tokenize("echo a#b"))).toEqual(["echo", "a#b"]);
  });

  test("errors", () => {
    expect(() => tokenize("'abc")).toThrow(ParseError);
    expect(() => tokenize('"abc')).toThrow(ParseError);
    expect(() => tokenize("a &")).toThrow(ParseError);
  });
});

describe("parse", () => {
  test("structure", () => {
    const script = parse("a | b && c > out; d");
    expect(script).toHaveLength(2);
    expect(script[0]!.first.commands).toHaveLength(2);
    expect(script[0]!.rest[0]!.op).toBe("&&");
    expect(script[0]!.rest[0]!.pipeline.commands[0]!.redirects[0]!.op).toBe(">");
  });

  test("empty input and empty statements", () => {
    expect(parse("")).toEqual([]);
    expect(parse(" ; ;; ")).toEqual([]);
  });

  test("syntax errors", () => {
    expect(() => parse("| a")).toThrow(/unexpected token '\|'/);
    expect(() => parse("a |")).toThrow(/unexpected token 'newline'/);
    expect(() => parse("a >")).toThrow(ParseError);
    expect(() => parse("a && ; b")).toThrow(ParseError);
  });
});
