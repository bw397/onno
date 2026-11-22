import type { VirtualFS } from "./VirtualFS";

export type Seed = (fs: VirtualFS) => void;

/** Initial disk contents, written the first time the app runs in a browser. */
export const defaultSeed: Seed = (fs) => {
  for (const dir of ["/bin", "/etc", "/home/user", "/tmp"]) fs.mkdir(dir, { recursive: true });

  fs.writeFile(
    "/etc/motd",
    "Welcome to onno.\nYour disk lives in this browser's IndexedDB.\n",
  );
  fs.writeFile(
    "/home/user/welcome.txt",
    [
      "Try a few commands:",
      "  ls -l /",
      "  mkdir -p notes && cd notes",
      "  echo hello > hi.txt; cat hi.txt",
      "  cd -; rm -r notes",
      "  cat /etc/motd",
      "  pwd",
      "  ls ~ > /tmp/listing; cat /tmp/listing",
      "  motd        (a script in /bin, found via $PATH)",
      "",
    ].join("\n"),
  );
  fs.writeFile("/bin/motd", "# Print the message of the day\ncat /etc/motd\n");
};
