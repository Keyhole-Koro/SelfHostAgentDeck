import { screen, sendKeys, type HerdrAgent } from "./herdr.ts";
import { parsePrompt, type ScreenPrompt } from "./prompts.ts";

/**
 * Answering the dialog on a session's screen with one of its choices: the pointer is moved to it
 * with the arrow keys, the screen is read again to see the pointer got there, and only then is
 * Enter pressed. That works for numbered lists and for the ones without numbers alike. A
 * permission prompt answered wrong (Yes for No) cannot be taken back, so if the choices changed
 * since the page showed them, or the pointer is not where it should be, nothing is picked.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pointer = (p: ScreenPrompt | undefined) => (p ? p.choices.findIndex((c) => c.selected) : -1);

export async function choose(a: HerdrAgent, index: number, label: string, pause = 120): Promise<{ label: string }> {
  const read = async () => parsePrompt(await screen(a));
  let p = await read();
  if (p?.choices[index]?.label !== label) throw new Error("Its screen shows other choices now; read it again.");
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
  if (pointer(p) !== index || p?.choices[index]?.label !== label) throw new Error(`The pointer did not get to “${label}”, so nothing was picked. Read its screen again.`);
  await sendKeys(a, ["enter"]);
  return { label };
}
