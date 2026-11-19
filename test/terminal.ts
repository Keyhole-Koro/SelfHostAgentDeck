import { spawn, type ChildProcess } from "node:child_process";

/** Runs a shell command in a new pty, prints its pid, and at the end the signal that closed it. */
const PTY = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-c", sys.argv[1]])
print(pid, flush=True)
while True:
    try:
        os.read(fd, 1024)
    except OSError:
        break
_, status = os.waitpid(pid, 0)
print("closed by", os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0, flush=True)
`;

/**
 * A command run in a terminal of its own, as a session in Ptyxis runs: what that terminal runs in
 * front. `pid()` is the command's process once it started; `signal()` the signal that ended it.
 */
export function inTerminal(command: string): { process: ChildProcess; pid: () => number | undefined; signal: () => number | undefined } {
  const p = spawn("python3", ["-c", PTY, command], { stdio: ["ignore", "pipe", "ignore"] });
  let said = "";
  p.stdout!.on("data", (d: Buffer) => (said += String(d)));
  const num = (re: RegExp) => {
    const m = re.exec(said);
    return m ? Number(m[1]) : undefined;
  };
  return { process: p, pid: () => num(/^(\d+)\n/), signal: () => num(/closed by (\d+)/) };
}
