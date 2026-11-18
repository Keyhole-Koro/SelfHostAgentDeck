import { execFile } from "node:child_process";

/**
 * The state of the pull requests sessions opened, from `gh pr view`: open, merged or closed,
 * whether CI passes, and the review decision. Looked up in the background and cached, so serving
 * the inbox never waits on GitHub: a status shows up on the next refresh.
 */

export interface PrStatus {
  url: string;
  number: number;
  title: string;
  /** OPEN, MERGED or CLOSED. */
  state: string;
  draft: boolean;
  /** APPROVED, CHANGES_REQUESTED or REVIEW_REQUIRED, when a review is required. */
  review?: string;
  /** CLEAN, BLOCKED, BEHIND, DIRTY (conflicts) … */
  mergeState?: string;
  checks: { passed: number; failed: number; pending: number };
  ci: "passing" | "failing" | "pending" | "none";
  at: number;
}

interface Entry {
  at: number;
  status?: PrStatus;
  error?: string;
  running?: Promise<void>;
}

const cache = new Map<string, Entry>();
/** Open pull requests change often; merged and closed ones hardly. */
const FRESH_OPEN = 60_000;
const FRESH_DONE = 30 * 60_000;
const MAX_RUNNING = 4;
let running = 0;
const waiting: (() => void)[] = [];

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.env["AGENT_DIFF_GH"] || "gh", args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

interface Check {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

export function summarize(raw: Record<string, unknown>, url: string, now = Date.now()): PrStatus {
  const checks = { passed: 0, failed: 0, pending: 0 };
  for (const c of (raw["statusCheckRollup"] as Check[] | null) ?? []) {
    if (c.__typename === "StatusContext" || (c.state && !c.status)) {
      if (c.state === "PENDING" || c.state === "EXPECTED") checks.pending++;
      else if (FAILED.has(c.state ?? "")) checks.failed++;
      else checks.passed++;
    } else if (c.status && c.status !== "COMPLETED") checks.pending++;
    else if (FAILED.has(c.conclusion ?? "")) checks.failed++;
    else checks.passed++;
  }
  const ci = checks.failed ? "failing" : checks.pending ? "pending" : checks.passed ? "passing" : "none";
  const status: PrStatus = {
    url: String(raw["url"] ?? url),
    number: Number(raw["number"] ?? 0),
    title: String(raw["title"] ?? ""),
    state: String(raw["state"] ?? "OPEN"),
    draft: raw["isDraft"] === true,
    checks,
    ci,
    at: now,
  };
  if (typeof raw["reviewDecision"] === "string" && raw["reviewDecision"]) status.review = raw["reviewDecision"];
  if (typeof raw["mergeStateStatus"] === "string" && raw["mergeStateStatus"]) status.mergeState = raw["mergeStateStatus"];
  return status;
}

/** Looks one pull request up now (at most four at a time); the result lands in the cache. */
export async function refreshPr(url: string): Promise<void> {
  const entry = cache.get(url) ?? { at: 0 };
  cache.set(url, entry);
  if (entry.running) return entry.running;
  entry.running = (async () => {
    if (running >= MAX_RUNNING) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      const out = await gh(["pr", "view", url, "--json", "number,title,state,isDraft,reviewDecision,statusCheckRollup,mergeStateStatus,url"]);
      entry.status = summarize(JSON.parse(out) as Record<string, unknown>, url);
      delete entry.error;
    } catch (e) {
      entry.error = (e as Error).message.split("\n")[0];
    } finally {
      entry.at = Date.now();
      running--;
      waiting.shift()?.();
      delete entry.running;
    }
  })();
  return entry.running;
}

/** What is known about these pull requests now; old or missing entries are refreshed in the background. */
export function prStatuses(urls: Iterable<string>, now = Date.now()): Record<string, PrStatus> {
  const out: Record<string, PrStatus> = {};
  for (const url of new Set(urls)) {
    const entry = cache.get(url);
    if (entry?.status) out[url] = entry.status;
    const ttl = entry?.status && entry.status.state !== "OPEN" ? FRESH_DONE : FRESH_OPEN;
    if (!entry || (!entry.running && now - entry.at >= ttl)) void refreshPr(url);
  }
  return out;
}
