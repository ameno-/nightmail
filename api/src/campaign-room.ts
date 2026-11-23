import { DurableObject } from 'cloudflare:workers';
import { AGENT_PRESENCE_MS, ROOM_PEER_HEADER, ROOM_READMIT, type RoomAgent, type RoomPerson } from './campaign-room-protocol.js';

// One room per campaign (roomName): who has its Write or Review page open, and which agents worked on it in the last two
// minutes. The API admits a person (GET /v1/campaigns/{id}/room in sending.ts: a dashboard session that can read the
// campaign, from the dashboard's Origin) and forwards the upgrade with them in ROOM_PEER_HEADER; nothing else reaches
// the object. People live on their sockets (serializeAttachment), so the room hibernates between events and costs
// nothing while nobody joins or leaves. Agents, who hold no socket, are reported only while someone is here (visit),
// and kept in storage only until the room is empty.
//
// An admission lasts ADMISSION_MS. Before the room sends anything to a socket past it, it closes that socket
// (ROOM_READMIT) and the tab joins again through the API, so a person whose session ended or who left the workspace
// receives nothing more.
//
// Room → browser, JSON text frames (unknown types and fields are ignored, so the room can add them):
//   { v: 1, type: 'hello', you, self, peers }  on connect: this socket's slot, this person's key, and everyone else
//                                              (an agent's ago: milliseconds since it was seen, so no clocks compare)
//   { v: 1, type: 'join', peer }          a person opened the campaign (peer: their key, name, view and slot)
//   { v: 1, type: 'leave', slot }         that tab closed or went away
//   { v: 1, type: 'agent', peer }         an agent read or saved the campaign
// What a person sees of others: names, never user IDs (keys are per room), and an agent's name only if they may see
// API keys and MCP clients in Settings (owners and admins); everyone else sees "An agent".
// Browser → room: 'ping' about every 30 s, answered 'pong' by the runtime without waking the room. Nothing else yet:
// any other frame closes the socket.
type Slotted = RoomPerson & { slot: number };
type Visit = { id: string; name: string };
const MAX_SOCKETS = 50, MAX_PER_PERSON = 5, AGENT = 'An agent';

export class CampaignRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // The sockets still admitted. One past its admission is closed now, so it is sent nothing more.
  private sockets(now = Date.now()) {
    return this.ctx.getWebSockets().flatMap(ws => {
      const peer = ws.deserializeAttachment() as Slotted | null;
      if (!peer) return [];
      if (peer.until <= now) { try { ws.close(ROOM_READMIT, 'Join again'); } catch { /* closing */ } return []; }
      return [{ ws, peer }];
    });
  }
  private agents(now = Date.now()) {
    return (this.ctx.storage.kv.get<RoomAgent[]>('agents') ?? []).filter(agent => now - agent.at < AGENT_PRESENCE_MS);
  }
  private shown = (agent: RoomAgent, to: Slotted) => to.names ? agent : { ...agent, name: AGENT };
  private send(ws: WebSocket, message: object) { try { ws.send(JSON.stringify({ v: 1, ...message })); } catch { /* closing */ } }
  private person = ({ kind, id, name, view, slot }: Slotted) => ({ kind, id, name, view, slot });

  override async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get(ROOM_PEER_HEADER);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !raw) return new Response(null, { status: 400 });
    const person = JSON.parse(decodeURIComponent(raw)) as RoomPerson;
    const now = Date.now(), here = this.sockets(now);
    if (here.length >= MAX_SOCKETS || here.filter(item => item.peer.id === person.id).length >= MAX_PER_PERSON) return new Response(null, { status: 429 });
    const taken = new Set(here.map(item => item.peer.slot));
    let slot = 1; while (taken.has(slot)) slot++;
    const peer: Slotted = { ...person, slot };
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);
    const agents = this.agents(now).map(agent => ({ ...this.shown(agent, peer), ago: now - agent.at }));
    this.send(server, { type: 'hello', you: slot, self: peer.id, peers: [...here.map(item => this.person(item.peer)), ...agents] });
    for (const item of here) this.send(item.ws, { type: 'join', peer: this.person(peer) });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** An agent read or saved the campaign (sending.ts, after its response). With nobody here it does nothing and says
   *  so (false), so the API can stop asking for a while; name is only looked up once someone is (resolve). */
  async visit(agent: Visit | { id: string; name?: undefined }): Promise<boolean> {
    const now = Date.now(), here = this.sockets(now);
    if (!here.length) return false;
    if (agent.name === undefined) return true;
    const seen: RoomAgent = { kind: 'agent', id: agent.id, name: agent.name, at: now };
    this.ctx.storage.kv.put('agents', [...this.agents(now).filter(item => item.id !== agent.id), seen]);
    for (const item of here) this.send(item.ws, { type: 'agent', peer: this.shown(seen, item.peer) });
    return true;
  }

  override async webSocketMessage(ws: WebSocket) { ws.close(1003, 'Unsupported message'); }
  override async webSocketClose(ws: WebSocket) { this.left(ws); }
  override async webSocketError(ws: WebSocket) { this.left(ws); }
  private left(ws: WebSocket) {
    const peer = ws.deserializeAttachment() as Slotted | null;
    const rest = this.sockets().filter(item => item.ws !== ws);
    if (peer) for (const item of rest) this.send(item.ws, { type: 'leave', slot: peer.slot });
    // The last one out: nothing is kept for an empty room.
    if (!rest.length) this.ctx.storage.kv.delete('agents');
  }
}
