import type { Builtin } from "../shell";

export const pwd: Builtin = {
  name: "pwd",
  summary: "print the current working directory",
  usage: "pwd",
  description: "Print the absolute path of the current working directory.",
  examples: [
    { command: "pwd", description: "Show where you are." },
    { command: "cd /tmp && pwd", description: "Prints /tmp." },
  ],
  run(ctx) {
    ctx.stdout(ctx.cwd + "\n");
    return 0;
  },
};
