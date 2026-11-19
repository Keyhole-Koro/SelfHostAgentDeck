import { screen, sendKeys, type HerdrAgent } from "./herdr.ts";
import { parsePrompt, type ScreenPrompt } from "./prompts.ts";

/**
 * Answering the dialog on a session's screen with one of its choices: the pointer is moved to it
 * with the arrow keys, the screen is read again to see the pointer got there, and only then is
 * Enter pressed. That works for numbered lists and for the ones without numbers alike. A
 * permission prompt answered wrong (Yes for No) cannot be taken back, so if the dialog is not the
 * one the page showed (its digest differs), or the pointer is not where it should be, nothing is
 * picked. One pane answers one pick at a time, and a dialog just answered is not answered again:
 * a second tap would otherwise land on whatever the agent shows next.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pointer = (p: ScreenPrompt | undefined) => (p ? p.choices.findIndex((c) => c.selected) : -1);

/** How long a dialog, once answered, cannot be answered again. */
const ANSWERED_FOR = 5000;
const queue = new Map<string, Promise<unknown>>();
const answered = new Map<string, { sig: string; at: number }>();

export function choose(a: HerdrAgent, index: number, label: string, sig: string, pause = 120): Promise<{ label: string }> {
  const at = `${a.socket}\n${a.pane}`;
  const run = (queue.get(at) ?? Promise.resolve()).catch(() => {}).then(() => pick(a, at, index, label, sig, pause));
  queue.set(at, run);
  void run.finally(() => queue.get(at) === run && queue.delete(at)).catch(() => {});
  return run;
}

async function pick(a: HerdrAgent, at: string, index: number, label: string, sig: string, pause: number): Promise<{ label: string }> {
  const last = answered.get(at);
  if (last && last.sig === sig && Date.now() - last.at < ANSWERED_FOR) throw new Error("That was just answered. Read its screen again.");
  const read = async () => parsePrompt(await screen(a));
  const same = (p: ScreenPrompt | undefined) => p?.sig === sig && p.choices[index]?.label === label;
  let p = await read();
  if (!same(p)) throw new Error("Its screen shows another question now; read it again.");
  const from = pointer(p);
  if (from < 0) throw new Error("Agent Deck cannot see which choice is selected on its screen; use the keys under it.");
  for (let n = Math.abs(index - from); n > 0; n--) {
    await sendKeys(a, [index > from ? "down" : "up"]);
    await sleep(40);
  }
  // The screen shows the move a moment later.
  for (let tries = 0; pointer(p) !== index && tries < 8; tries++) {
    await sleep(pause);
    p = await read();
  }
  if (pointer(p) !== index || !same(p)) throw new Error(`The pointer did not get to “${label}”, so nothing was picked. Read its screen again.`);
  await sendKeys(a, ["enter"]);
  answered.set(at, { sig, at: Date.now() });
  return { label };
}
