// The name agent setup gives an agent's API key (agent-setup.ts), shared with the dashboard's /connect page.
const SET_UP = ', set up 0000-00-00'.length;
/** The client the agent named (its claim, cut to fit a key name's 100 characters), or "Agent", and the day it was set up. */
export function agentKeyName(client: string | null, day = new Date().toISOString().slice(0, 10)) {
  const chars = Array.from(client ?? 'Agent');
  return `${chars.length > 100 - SET_UP ? `${chars.slice(0, 99 - SET_UP).join('')}…` : chars.join('')}, set up ${day}`;
}
