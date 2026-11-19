import { execFile } from "node:child_process";

/**
 * Why a pull request's CI failed, to hand to the session that opened it: the failing checks
 * (`gh pr checks`), and the end of each failing GitHub Actions run's log (`gh run view
 * --log-failed`), without timestamps and colours.
 */

export interface FailedCheck {
  name: string;
  link: string;
}

export interface CiFailure {
  checks: FailedCheck[];
  log: string;
}

/** Lines kept from the end of each run's failing log, and characters in all. */
const TAIL_LINES = 120;
const MAX_CHARS = 16_000;

/** gh's output; `gh pr checks` exits non-zero when checks fail, and still prints them. */
function gh(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.env["AGENT_DIFF_GH"] || "gh", args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout) return resolve(stdout);
      reject(err ? new Error(String(stderr || err.message).trim().split("\n")[0]) : new Error("gh printed nothing"));
    });
  });
}

/** `job<TAB>step<TAB>2026-…Z line` → the line, with a "job › step" header where they change. */
export function cleanLog(raw: string): string[] {
  const out: string[] = [];
  let where = "";
  for (const line of raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n")) {
    const m = /^([^\t]*)\t([^\t]*)\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?(.*)$/.exec(line);
    if (!m) {
      if (line.trim()) out.push(line);
      continue;
    }
    const here = `${m[1]} › ${m[2]}`;
    if (here !== where) out.push(`── ${(where = here)}`);
    out.push(m[3]!);
  }
  return out;
}

export async function ciFailure(prUrl: string): Promise<CiFailure> {
  const checks = (JSON.parse(await gh(["pr", "checks", prUrl, "--json", "name,bucket,link"])) as { name?: string; bucket?: string; link?: string }[]).filter((c) => c.bucket === "fail");
  const runs = new Map<string, string>(); // run id → owner/repo
  for (const c of checks) {
    const m = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/.exec(c.link ?? "");
    if (m) runs.set(m[2]!, m[1]!);
  }
  const parts: string[] = [];
  for (const [run, repo] of runs) {
    try {
      parts.push(cleanLog(await gh(["run", "view", run, "--repo", repo, "--log-failed"])).slice(-TAIL_LINES).join("\n"));
    } catch (e) {
      parts.push(`(the log of run ${run} could not be read: ${(e as Error).message})`);
    }
  }
  let log = parts.join("\n\n");
  if (log.length > MAX_CHARS) log = "…\n" + log.slice(-MAX_CHARS);
  return { checks: checks.map((c) => ({ name: c.name ?? "check", link: c.link ?? "" })), log };
}
