/**
 * A setting from the environment: AGENT_DECK_<name>, or AGENT_DIFF_<name> as it was called before
 * the rename (tests' fakes, scripts people wrote).
 */
export const env = (name: string): string | undefined => process.env[`AGENT_DECK_${name}`] || process.env[`AGENT_DIFF_${name}`] || undefined;
