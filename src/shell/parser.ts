import { ParseError, tokenize } from "./lexer";
import type { AndOrList, Operator, OpToken, Pipeline, Script, SimpleCommand, Token } from "./types";

/**
 * Grammar:
 *   script   := andOr ( ';' andOr )*          (empty statements allowed)
 *   andOr    := pipeline ( ('&&' | '||') pipeline )*
 *   pipeline := command ( '|' command )*
 *   command  := ( WORD | redirect )+
 *   redirect := ( '>' | '>>' | '<' ) WORD
 */
export function parse(input: string): Script {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const isOp = (t: Token | undefined, ...ops: Operator[]): t is OpToken =>
    t?.type === "op" && ops.includes(t.value);
  const unexpected = (t: Token | undefined) =>
    new ParseError(
      `syntax error near unexpected token '${t ? (t.type === "op" ? t.value : "word") : "newline"}'`,
    );

  function parseCommand(): SimpleCommand {
    const cmd: SimpleCommand = { argv: [], redirects: [] };
    for (;;) {
      const t = peek();
      if (t?.type === "word") {
        cmd.argv.push(t.parts);
        pos++;
      } else if (isOp(t, ">", ">>", "<")) {
        pos++;
        const target = peek();
        if (target?.type !== "word") throw unexpected(target);
        cmd.redirects.push({ op: t.value as ">" | ">>" | "<", target: target.parts });
        pos++;
      } else {
        break;
      }
    }
    if (!cmd.argv.length && !cmd.redirects.length) throw unexpected(peek());
    return cmd;
  }

  function parsePipeline(): Pipeline {
    const commands = [parseCommand()];
    while (isOp(peek(), "|")) {
      pos++;
      commands.push(parseCommand());
    }
    return { commands };
  }

  function parseAndOr(): AndOrList {
    const list: AndOrList = { first: parsePipeline(), rest: [] };
    for (let t = peek(); isOp(t, "&&", "||"); t = peek()) {
      pos++;
      list.rest.push({ op: t.value as "&&" | "||", pipeline: parsePipeline() });
    }
    return list;
  }

  const script: Script = [];
  while (pos < tokens.length) {
    if (isOp(peek(), ";")) {
      pos++;
      continue;
    }
    script.push(parseAndOr());
    const t = peek();
    if (t && !isOp(t, ";")) throw unexpected(t);
  }
  return script;
}
