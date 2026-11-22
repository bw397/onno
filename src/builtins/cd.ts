import { FsError } from "../fs";
import type { Builtin } from "../shell";

export const cd: Builtin = {
  name: "cd",
  summary: "change the working directory",
  usage: "cd [DIR]",
  description:
    "Change the shell's working directory to DIR. With no DIR, go to $HOME. " +
    "With -, go back to the previous directory ($OLDPWD) and print it.",
  examples: [
    { command: "cd /etc", description: "Go to an absolute path." },
    { command: "cd ..", description: "Go up one level." },
    { command: "cd", description: "Go home." },
    { command: "cd -", description: "Return to the previous directory." },
  ],
  run(ctx) {
    if (ctx.args.length > 1) {
      ctx.stderr("cd: too many arguments\n");
      return 1;
    }
    let target = ctx.args[0] ?? ctx.env.HOME ?? "/";
    const printNew = target === "-";
    if (printNew) {
      if (!ctx.env.OLDPWD) {
        ctx.stderr("cd: OLDPWD not set\n");
        return 1;
      }
      target = ctx.env.OLDPWD;
    }

    const previous = ctx.shell.cwd;
    try {
      ctx.shell.setCwd(target);
    } catch (err) {
      if (!(err instanceof FsError)) throw err;
      ctx.stderr(`cd: ${target}: ${err.message}\n`);
      return 1;
    }
    ctx.env.OLDPWD = previous;
    if (printNew) ctx.stdout(ctx.shell.cwd + "\n");
    return 0;
  },
};
