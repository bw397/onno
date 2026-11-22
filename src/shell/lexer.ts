import type { Operator, Token, WordPart } from "./types";

export class ParseError extends Error {
  override name = "ParseError";
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_VAR = /[0-9?#@]/;
const OP_CHARS = new Set(["|", "&", ";", ">", "<"]);
const TILDE_END = /[\s/;|&<>]/;

/**
 * Split shell input into words and operators.
 *
 * Supports: whitespace separation, 'single quotes', "double quotes" (with $ expansion
 * and \ escapes), backslash escapes, $VAR / ${VAR} / $? / $1, leading ~, # comments,
 * and the operators | || && ; > >> <. Newlines act like `;`.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  // Current word being built; null when between words.
  const cur: { parts: WordPart[] | null } = { parts: null };

  const literal = (text: string) => {
    const parts = (cur.parts ??= []);
    const last = parts[parts.length - 1];
    if (last?.kind === "literal") last.value += text;
    else parts.push({ kind: "literal", value: text });
  };
  const variable = (name: string) => {
    (cur.parts ??= []).push({ kind: "var", name });
  };
  const endWord = () => {
    if (cur.parts) tokens.push({ type: "word", parts: cur.parts });
    cur.parts = null;
  };
  const op = (value: Operator) => {
    endWord();
    tokens.push({ type: "op", value });
  };

  /** Read a `$` expansion at `start`; returns the index just past it. */
  const readDollar = (start: number): number => {
    const next = input[start + 1];
    if (next === "{") {
      const close = input.indexOf("}", start + 2);
      if (close === -1) throw new ParseError("unterminated ${");
      const name = input.slice(start + 2, close);
      if (!/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#@])$/.test(name)) {
        throw new ParseError(`bad substitution: \${${name}}`);
      }
      variable(name);
      return close + 1;
    }
    if (next !== undefined && NAME_START.test(next)) {
      let j = start + 1;
      while (j < input.length && NAME_CHAR.test(input[j]!)) j++;
      variable(input.slice(start + 1, j));
      return j;
    }
    if (next !== undefined && SPECIAL_VAR.test(next)) {
      variable(next);
      return start + 2;
    }
    literal("$");
    return start + 1;
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i]!;

    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === "\n") {
      op(";");
      i++;
    } else if (c === "#" && cur.parts === null) {
      while (i < input.length && input[i] !== "\n") i++;
    } else if (c === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) throw new ParseError("unterminated single quote");
      literal(input.slice(i + 1, close));
      i = close + 1;
    } else if (c === '"') {
      literal(""); // ensures "" produces an (empty) word
      i++;
      for (;;) {
        if (i >= input.length) throw new ParseError("unterminated double quote");
        const d = input[i]!;
        if (d === '"') {
          i++;
          break;
        }
        const n = input[i + 1];
        if (d === "\\" && n !== undefined && '$"\\\n'.includes(n)) {
          if (n !== "\n") literal(n);
          i += 2;
        } else if (d === "$") {
          i = readDollar(i);
        } else {
          literal(d);
          i++;
        }
      }
    } else if (c === "\\") {
      const n = input[i + 1];
      if (n !== undefined && n !== "\n") literal(n);
      i += 2;
    } else if (c === "$") {
      i = readDollar(i);
    } else if (c === "~" && cur.parts === null && (i + 1 >= input.length || TILDE_END.test(input[i + 1]!))) {
      variable("HOME");
      i++;
    } else if (OP_CHARS.has(c)) {
      const two = input.slice(i, i + 2);
      if (two === "||" || two === "&&" || two === ">>") {
        op(two);
        i += 2;
      } else if (c === "&") {
        throw new ParseError("background jobs (&) are not supported");
      } else {
        op(c as Operator);
        i++;
      }
    } else {
      literal(c);
      i++;
    }
  }
  endWord();
  return tokens;
}
