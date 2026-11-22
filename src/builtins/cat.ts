import { FsError } from "../fs";
import type { Builtin } from "../shell";

export const cat: Builtin = {
  name: "cat",
  summary: "concatenate files and print them",
  usage: "cat [FILE]...",
  description: "Print each FILE in order. With no FILE, or when FILE is -, read standard input.",
  examples: [
    { command: "cat welcome.txt", description: "Print a file." },
    { command: "cat a.txt b.txt > both.txt", description: "Join two files into a third." },
    { command: "echo first | cat - welcome.txt", description: "Print standard input, then a file." },
  ],
  run(ctx) {
    const files = ctx.args.length ? ctx.args : ["-"];
    let status = 0;
    for (const file of files) {
      if (file === "-") {
        ctx.stdout(ctx.stdin);
        continue;
      }
      try {
        ctx.stdout(ctx.fs.readFile(ctx.resolvePath(file)));
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        ctx.stderr(`cat: ${file}: ${err.message}\n`);
        status = 1;
      }
    }
    return status;
  },
};
