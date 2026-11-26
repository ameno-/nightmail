import type { Param, ToolHost } from './tools.js';

// The seam between the conversation (Durable Object, protocol, stamp, gate) and the agent runtime (OpenCode, see
// opencode.ts). The conversation only needs: run one turn of the agent with this input, report its tool steps as they
// happen, return its text and usage. Keeping it this small is what keeps the OpenCode version upgradable. The text comes
// only with the result, so it can pass the output gate before anyone sees it.

export type HarnessEvent =
  | { type: 'tool.start'; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool.end'; callId: string; tool: string; ok: boolean };
/** inputTokens: uncached input plus cache writes; cacheReadTokens: cached input, billed at a tenth. */
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
const SPENT = Symbol('spent');
/** Marks an error a turn threw with what its model calls had already spent, so the caller still counts it. */
export function withSpent(error: unknown, usage: Usage) {
  if ((usage.costUsd > 0 || usage.inputTokens > 0 || usage.outputTokens > 0) && error !== null && typeof error === 'object' && Object.isExtensible(error)) Object.defineProperty(error, SPENT, { value: { ...usage } });
  return error;
}
/** What a turn that threw had spent (withSpent), or null. */
export const spentBy = (error: unknown): Usage | null => error !== null && typeof error === 'object' ? (error as { [SPENT]?: Usage })[SPENT] ?? null : null;
export type TurnInput = {
  /** What the agent reads as the next user message (the customer's words, or a harness note in brackets). */
  text: string;
  /** Per-turn context the harness adds to the system prompt: <customer> and <account>. */
  context: string;
  /** The tools this turn may call (toolNames in tools.ts): the model is offered these and no others. */
  tools: readonly string[];
  /** Screenshots for this message, as data URIs (checked and stripped by image.ts). */
  images?: { uri: string; name: string }[];
};
/**
 * `text`: what the agent wrote, with the fence's escapes undone (projection.ts unfenced), as are its tool arguments.
 * refused: the model declined to answer (stop_reason "refusal"); `text` is then empty, whatever it wrote before stopping.
 */
export type TurnResult = { text: string; usage: Usage; aborted: boolean; error?: string; refused?: boolean };

/** A tool the harness offers the model: its schema, and what it does through the turn's host (`H`). */
export type HarnessTool<H> = { name: string; description: string; params: Record<string, Param>; execute: (args: Record<string, unknown>, host: H) => Promise<string> };

export interface Harness<H = ToolHost> {
  turn(input: TurnInput, tools: H, onEvent: (event: HarnessEvent) => void, signal: AbortSignal): Promise<TurnResult>;
  /** Stops OpenCode, so its object's storage can be removed. */
  close(): Promise<void>;
}
