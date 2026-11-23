import { DurableObject } from 'cloudflare:workers';
import { AGENT_PRESENCE_MS, ROOM_PEER_HEADER, type RoomAgent, type RoomPerson } from './campaign-room-protocol.js';

// One room per campaign (roomName): who has its Write or Review page open, and which agents worked on it in the last two
// minutes. The API admits a person (GET /v1/campaigns/{id}/room in sending.ts: a dashboard session that can read the
// campaign, from the dashboard's Origin) and forwards the upgrade with them in ROOM_PEER_HEADER; nothing else reaches
// the object. People live on their sockets (serializeAttachment), so the room hibernates between events and costs
// nothing while nobody joins or leaves; agents, who hold no socket, are kept in storage until they go quiet.
//
// Room → browser, JSON text frames (unknown types and fields are ignored, so the room can add them):
//   { v: 1, type: 'hello', you, peers }   on connect: this socket's slot, and everyone else in the room (an agent's
//                                         ago: milliseconds since it was seen, so no browser compares clocks)
//   { v: 1, type: 'join', peer }          a person opened the campaign (peer: RoomPerson and its slot)
//   { v: 1, type: 'leave', slot }         that tab closed or went away
//   { v: 1, type: 'agent', peer }         an agent read or saved the campaign (peer: RoomAgent)
// Browser → room: 'ping' about every 30 s, answered 'pong' by the runtime without waking the room. Nothing else yet:
// any other frame closes the socket.
type Slotted = RoomPerson & { slot: number };
const MAX_SOCKETS = 50;

export class CampaignRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private people(except?: WebSocket) {
    return this.ctx.getWebSockets().flatMap(ws => { const peer = ws === except ? null : ws.deserializeAttachment() as Slotted | null; return peer ? [peer] : []; });
  }
  private agents(now = Date.now()) {
    return (this.ctx.storage.kv.get<RoomAgent[]>('agents') ?? []).filter(agent => now - agent.at < AGENT_PRESENCE_MS);
  }
  private broadcast(message: object, except?: WebSocket) {
    const text = JSON.stringify({ v: 1, ...message });
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) try { ws.send(text); } catch { /* closing */ }
  }

  override async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get(ROOM_PEER_HEADER);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !raw) return new Response(null, { status: 400 });
    const person = JSON.parse(raw) as RoomPerson;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS) return new Response(null, { status: 429 });
    const taken = new Set(this.people().map(peer => peer.slot));
    let slot = 1; while (taken.has(slot)) slot++;
    const peer: Slotted = { ...person, slot };
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);
    const now = Date.now();
    server.send(JSON.stringify({ v: 1, type: 'hello', you: slot, peers: [...this.people(server), ...this.agents(now).map(agent => ({ ...agent, ago: now - agent.at }))] }));
    this.broadcast({ type: 'join', peer }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** An agent read or saved the campaign (sending.ts, after its response). */
  async agent(agent: RoomAgent) {
    const now = Date.now(), seen = { ...agent, at: now };
    this.ctx.storage.kv.put('agents', [...this.agents(now).filter(item => item.id !== agent.id), seen]);
    this.broadcast({ type: 'agent', peer: seen });
  }

  override async webSocketMessage(ws: WebSocket) { ws.close(1003, 'Unsupported message'); }
  override async webSocketClose(ws: WebSocket) { this.left(ws); }
  override async webSocketError(ws: WebSocket) { this.left(ws); }
  private left(ws: WebSocket) {
    const peer = ws.deserializeAttachment() as Slotted | null;
    if (peer) this.broadcast({ type: 'leave', slot: peer.slot }, ws);
  }
}
