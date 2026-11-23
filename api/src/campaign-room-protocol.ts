// What the dashboard's campaign rooms carry (src/campaign-room.ts), shared by the room and the API route that admits
// people to it. No imports: the room is evaluated when the Worker starts, and this keeps it as light as the dispatcher.

/** The person the API admitted, in the header of the upgrade it forwards. A browser's own header of this name never
 *  reaches the room: the route builds that request itself. */
export const ROOM_PEER_HEADER = 'x-nightmail-room-peer';
/** How long an agent stays in a room after it last read or saved the campaign. Agents hold no socket. */
export const AGENT_PRESENCE_MS = 120_000;
export type RoomView = 'write' | 'review';
/** A person with the campaign open, one per tab. id is the account's user ID, never an email address. */
export type RoomPerson = { kind: 'person'; id: string; name: string; view: RoomView };
/** An API key or MCP client that read or saved the campaign; at is when, in epoch milliseconds. */
export type RoomAgent = { kind: 'agent'; id: string; name: string; at: number };
/** The room's name: one per campaign, inside its workspace. */
export const roomName = (workspaceId: string, campaignId: string) => `${workspaceId}/${campaignId}`;
