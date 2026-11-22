import { FsError } from "../fs";
import type { Builtin } from "../shell";

export const cat: Builtin = {
  name: "cat",
  summary: "concatenate files and print them",
  usage: "cat [FILE]...",
  description:
    "Print each FILE in order. With no FILE, or when FILE is -, read standard input: " +
    "from the terminal, type lines and press Ctrl+D (on an empty line) to finish, so " +
    "cat > file writes what you type into file.",
  examples: [
    { command: "cat welcome.txt", description: "Print a file." },
    { command: "cat a.txt b.txt > both.txt", description: "Join two files into a third." },
    { command: "echo first | cat - welcome.txt", description: "Print standard input, then a file." },
    { command: "cat > notes.txt", description: "Type text into a new file; finish with Ctrl+D." },
    { command: "cat >> notes.txt", description: "Append typed text to a file." },
  ],
  async run(ctx) {
    const files = ctx.args.length ? ctx.args : ["-"];
    let status = 0;
    for (const file of files) {
      if (file === "-") {
        // From the terminal this copies each line as it's typed, until Ctrl+D.
        for await (const chunk of ctx.stdinChunks()) ctx.stdout(chunk);
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
