// What the dashboard's campaign rooms carry (src/campaign-room.ts), shared by the room and the API route that admits
// people to it. No imports: the room is evaluated when the Worker starts, and this keeps it as light as the dispatcher.

/** The person the API admitted, in the header of the upgrade it forwards (URI-encoded JSON). A browser's own header of
 *  this name never reaches the room: the route builds that request itself. */
export const ROOM_PEER_HEADER = 'x-nightmail-room-peer';
/** How long an agent stays in a room after it last read or saved the campaign. Agents hold no socket. */
export const AGENT_PRESENCE_MS = 120_000;
/** How long an admission lasts. A socket past it is closed (code ROOM_READMIT) before the room sends it anything, and
 *  the tab joins again through the API, which checks the session and membership afresh. Nothing happens while the room
 *  is quiet, so a person alone pays nothing for it. */
export const ADMISSION_MS = 120_000;
export const ROOM_READMIT = 4000;
export type RoomView = 'write' | 'review';
/** A person with the campaign open, one per tab. id is a key for this person in this room only (never their user ID);
 *  names: whether they may see API keys' and MCP clients' names (owners and admins, as Settings shows them). */
export type RoomPerson = { kind: 'person'; id: string; name: string; view: RoomView; names: boolean; until: number };
/** An API key or MCP client that read or saved the campaign: id is its key in this room, at is when (epoch ms). */
export type RoomAgent = { kind: 'agent'; id: string; name: string; at: number };
/** The room's name: one per campaign, inside its workspace. */
export const roomName = (workspaceId: string, campaignId: string) => `${workspaceId}/${campaignId}`;
