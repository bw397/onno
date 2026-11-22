import type { Builtin } from "../shell";

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", r: "\r", a: "\x07", b: "\b", e: "\x1b" };

function interpret(s: string): string {
  return s.replace(/\\(.)/g, (whole, c: string) => ESCAPES[c] ?? whole);
}

export const echo: Builtin = {
  name: "echo",
  summary: "print arguments",
  usage: `echo [-n] [-e] [STRING]...
  -n   don't print the trailing newline
  -e   interpret backslash escapes: \\n \\t \\\\ \\r \\a \\b \\e`,
  description: "Print the STRINGs separated by spaces, followed by a newline.",
  examples: [
    { command: "echo hello world", description: "Print some text." },
    { command: 'echo "home is $HOME"', description: "Variables expand inside double quotes." },
    { command: "echo -e 'name\\tsize\\nfoo\\t12'", description: "Use escapes for tabs and newlines." },
    { command: "echo remember milk >> todo.txt", description: "Append a line to a file." },
  ],
  run(ctx) {
    let newline = true;
    let escapes = false;
    let i = 0;
    // Like bash: leading args made only of n/e flags are options; anything else is text.
    for (; i < ctx.args.length; i++) {
      const arg = ctx.args[i]!;
      if (!/^-[ne]+$/.test(arg)) break;
      if (arg.includes("n")) newline = false;
      if (arg.includes("e")) escapes = true;
    }
    const text = ctx.args.slice(i).join(" ");
    ctx.stdout((escapes ? interpret(text) : text) + (newline ? "\n" : ""));
    return 0;
  },
};
