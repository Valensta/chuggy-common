/**
 * The POSIX shells a suite runs a script of this core under: this machine's
 * `/bin/sh`, and dash and busybox's where this machine has them, since either
 * may be the `/bin/sh` of an image a job runs in; and the shells an agent's
 * own shell tool runs a command in. Each is named by its path, so a suite
 * that hands its script a PATH of stubs still finds it.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** The first executable `name` on this process's PATH, or nothing. */
function shellsFound(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not in this directory
    }
  }
  return undefined;
}

const dash = shellsFound("dash");
const busybox = shellsFound("busybox");
const bash = shellsFound("bash");
const zsh = shellsFound("zsh");

/** Each shell, with the argv that runs a script under it, or a reason this machine cannot. */
export const posixShells = [
  { name: "/bin/sh", argv: ["/bin/sh"] },
  dash === undefined
    ? { name: "dash", absent: "no dash on this machine" }
    : { name: "dash", argv: [dash] },
  busybox === undefined
    ? { name: "busybox sh", absent: "no busybox on this machine" }
    : { name: "busybox sh", argv: [busybox, "sh"] },
];

/** The shells Claude Code's Bash tool runs a command in where an image has one, with the argv that runs a script under each. */
export const agentShells = [
  bash === undefined
    ? { name: "bash", absent: "no bash on this machine" }
    : { name: "bash", argv: [bash] },
  zsh === undefined
    ? { name: "zsh", absent: "no zsh on this machine" }
    : { name: "zsh", argv: [zsh] },
];
