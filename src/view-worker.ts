import { parentPort } from "node:worker_threads";
import { readClaude } from "./claude.ts";
import { readCodex } from "./codex.ts";
import { applyAdd, findSession, load, planAdd } from "./core.ts";
import { buildView } from "./view.ts";

/**
 * Attribution off the server's main thread. The first look reads every transcript of the window
 * (GBs over a month, seconds of work); done here, the page keeps refreshing meanwhile, and the
 * transcripts this thread has parsed stay cached for the next look.
 */

export type ViewRequest =
  | { id: number; op: "warm"; days: number }
  | { id: number; op: "view"; root: string; days: number; base?: string; since?: number }
  | { id: number; op: "stage"; root: string; days: number; base?: string; since?: number; session: string; apply: boolean };

parentPort?.on("message", (m: ViewRequest) => {
  try {
    if (m.op === "warm") {
      const since = Date.now() - m.days * 864e5;
      const t = { sessions: new Map(), events: [], shells: [] };
      readClaude(t, since);
      readCodex(t, since);
      return parentPort!.postMessage({ id: m.id, ok: true });
    }
    const loaded = load(m.root, { days: m.days, base: m.base, since: m.since });
    if (m.op === "view") return parentPort!.postMessage({ id: m.id, ok: buildView(loaded) });
    const key = findSession(loaded.transcripts, m.session);
    const plan = planAdd(loaded, key);
    if (m.apply) applyAdd(m.root, plan);
    parentPort!.postMessage({ id: m.id, ok: { whole: plan.whole, partial: plan.partial.map((p) => ({ path: p.rel, hunks: p.hunks })), skipped: plan.skipped, applied: m.apply } });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: (e as Error).message });
  }
});
