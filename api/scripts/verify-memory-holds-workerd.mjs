#!/usr/bin/env node
// Verifies under real workerd (wrangler dev) that memory budget holds always end across attachment downloads,
// template asset downloads, and contact import responses when clients stop reading and close connections.
// Usage:
//   API_DIR=<repo>/api DB_URL=postgres://... node api/scripts/verify-memory-holds-workerd.mjs <port> [rounds]
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const [portArg, roundsArg] = process.argv.slice(2);
const port = Number(portArg);
const soakRounds = Number(roundsArg ?? '3');
if (!Number.isFinite(port) || port <= 0) {
  console.error('Usage: API_DIR=<repo>/api DB_URL=postgres://... node verify-memory-holds-workerd.mjs <port> [rounds]');
  process.exit(2);
}

const req = createRequire((process.env.API_DIR ?? process.cwd()) + '/package.json');
const { Pool } = req('pg');
const pool = new Pool({ connectionString: process.env.DB_URL, max: 3 });
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KEYS = {
  w1: 'nm_' + 'a'.repeat(64),
  w2: 'nm_' + 'b'.repeat(64),
  victim: 'nm_' + 'c'.repeat(64),
};

for (const [name, secret] of Object.entries(KEYS)) {
  const ws = 'ws_mhe_' + name;
  await pool.query("INSERT INTO workspaces (id,name,slug) VALUES ($1,$1,replace($1,'_','-')) ON CONFLICT DO NOTHING", [ws]);
  await pool.query("INSERT INTO operation_settings (workspace_id, name) VALUES ($1,$1) ON CONFLICT DO NOTHING", [ws]);
  await pool.query(
    "INSERT INTO api_keys (id, workspace_id, name, hash, prefix, permissions, domains) VALUES ('key_mhe_' || md5($2), $1, 'mhe', encode(sha256(convert_to($2,'UTF8')),'hex'), left($2, 11), '[\"read\",\"send\",\"manage\"]'::jsonb, '[]'::jsonb) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions",
    [ws, secret],
  );
}

async function apiCall(key, method, path, body, timeout = 15_000) {
  const t0 = performance.now();
  const res = await fetch(base + path, {
    method,
    headers: { authorization: 'Bearer ' + key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, ms: Math.round(performance.now() - t0), bytes: text.length, json };
}

function openUnread(key, path, count) {
  return Promise.all(Array.from({ length: count }, () => new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.on('error', () => {});
    s.on('connect', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${key}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      resolve(s);
    });
  })));
}

function openSlowThenDrop(key, path, count, dropAfterMs = 2000) {
  return Promise.all(Array.from({ length: count }, () => new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let bytes = 0;
    s.on('error', () => {});
    s.on('data', chunk => {
      bytes += chunk.length;
      s.pause();
      setTimeout(() => { if (!s.destroyed) s.resume(); }, 250);
    });
    s.on('connect', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${key}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      setTimeout(() => { s.destroy(); resolve(bytes); }, dropAfterMs);
    });
  })));
}

const results = {};

// 1. Attachment downloads: saturate 64 MiB across two workspaces (unread + slow-drop), close sockets, verify victim recovers within deadline.
const bigBuf = Buffer.alloc(7 * 1024 * 1024, 0x41).toString('base64');
const tinyBuf = Buffer.from('tiny').toString('base64');
const att1 = await apiCall(KEYS.w1, 'POST', '/v1/attachments', JSON.stringify({ filename: 'big1.png', contentType: 'image/png', disposition: 'inline', contentId: 'cid-big1', content: bigBuf }), 60_000);
const att2 = await apiCall(KEYS.w2, 'POST', '/v1/attachments', JSON.stringify({ filename: 'big2.png', contentType: 'image/png', disposition: 'inline', contentId: 'cid-big2', content: bigBuf }), 60_000);
const attV = await apiCall(KEYS.victim, 'POST', '/v1/attachments', JSON.stringify({ filename: 'tiny.png', contentType: 'image/png', disposition: 'inline', contentId: 'cid-tiny', content: tinyBuf }));
assert.equal(att1.status, 201);
assert.equal(att2.status, 201);
assert.equal(attV.status, 201);

const attSocks1 = await openUnread(KEYS.w1, `/v1/attachments/${att1.json.id}/content`, 6);
const attSocks2 = await openUnread(KEYS.w2, `/v1/attachments/${att2.json.id}/content`, 4);
await sleep(2000);
for (const s of [...attSocks1, ...attSocks2]) s.destroy();
const attVictimUnread = await apiCall(KEYS.victim, 'GET', `/v1/attachments/${attV.json.id}/content`, undefined, 15_000);
assert.equal(attVictimUnread.status, 200, 'Victim attachment download must succeed after abandoned unread downloads');

await Promise.all([
  openSlowThenDrop(KEYS.w1, `/v1/attachments/${att1.json.id}/content`, 6, 2000),
  openSlowThenDrop(KEYS.w2, `/v1/attachments/${att2.json.id}/content`, 4, 2000),
]);
const attVictimSlow = await apiCall(KEYS.victim, 'GET', `/v1/attachments/${attV.json.id}/content`, undefined, 15_000);
assert.equal(attVictimSlow.status, 200, 'Victim attachment download must succeed after abandoned slow downloads');
results.attachments = { victimAfterUnreadMs: attVictimUnread.ms, victimAfterSlowDropMs: attVictimSlow.ms };

// 2. Template assets: saturate across two workspaces (unread), close sockets, verify victim recovers within deadline.
const pngHeader = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(6 * 1024 * 1024, 0x42)]).toString('base64');
const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const ta1 = await apiCall(KEYS.w1, 'POST', '/v1/template-assets', JSON.stringify({ filename: 'a1.png', contentType: 'image/png', disposition: 'inline', contentId: 'ta-1', content: pngHeader }), 60_000);
const ta2 = await apiCall(KEYS.w2, 'POST', '/v1/template-assets', JSON.stringify({ filename: 'a2.png', contentType: 'image/png', disposition: 'inline', contentId: 'ta-2', content: pngHeader }), 60_000);
const taV = await apiCall(KEYS.victim, 'POST', '/v1/template-assets', JSON.stringify({ filename: 'av.png', contentType: 'image/png', disposition: 'inline', contentId: 'ta-v', content: tinyPng }));
assert.equal(ta1.status, 201);
assert.equal(ta2.status, 201);
assert.equal(taV.status, 201);

const taSocks1 = await openUnread(KEYS.w1, `/v1/template-assets/${ta1.json.id}/content`, 6);
const taSocks2 = await openUnread(KEYS.w2, `/v1/template-assets/${ta2.json.id}/content`, 4);
await sleep(2000);
for (const s of [...taSocks1, ...taSocks2]) s.destroy();
const taVictim = await apiCall(KEYS.victim, 'GET', `/v1/template-assets/${taV.json.id}/content`, undefined, 15_000);
assert.equal(taVictim.status, 200, 'Victim template asset download must succeed after abandoned unread reads');
results.templateAssets = { victimAfterUnreadMs: taVictim.ms };

// 3. Contact import answers: 2 workspaces open 8 unread 50k-row import reads each and close, verify victim reads & previews cleanly.
const rowsSql = "(SELECT jsonb_agg(jsonb_build_object('row', g, 'email', 'mhe-' || g || '@example.net', 'name', repeat('n', 60), 'properties', jsonb_build_object('plan', repeat('p', 60)))) FROM generate_series(1, 50000) g)";
const imp1 = 'imp_' + 'a'.repeat(32);
const imp2 = 'imp_' + 'b'.repeat(32);
const impV = 'imp_' + 'c'.repeat(32);
for (const [ws, id] of [['ws_mhe_w1', imp1], ['ws_mhe_w2', imp2]]) {
  await pool.query(`INSERT INTO audience_imports(id,workspace_id,status,rows,errors,imported) SELECT $1,$2,'committed',${rowsSql},'[]'::jsonb,50000 WHERE NOT EXISTS (SELECT 1 FROM audience_imports WHERE id=$1)`, [id, ws]);
}
await pool.query("INSERT INTO audience_imports(id,workspace_id,status,rows,errors,imported) VALUES ($1,'ws_mhe_victim','committed',$2::jsonb,'[]'::jsonb,1) ON CONFLICT (id) DO NOTHING", [impV, JSON.stringify([{ row: 2, email: 'v@example.net', properties: {} }])]);

const impSocks1 = await openUnread(KEYS.w1, `/v1/contact-imports/${imp1}`, 8);
const impSocks2 = await openUnread(KEYS.w2, `/v1/contact-imports/${imp2}`, 8);
await sleep(2000);
for (const s of [...impSocks1, ...impSocks2]) s.destroy();
const impVictimRead = await apiCall(KEYS.victim, 'GET', `/v1/contact-imports/${impV}`, undefined, 15_000);
const impVictimPrev = await apiCall(KEYS.victim, 'POST', '/v1/contact-imports', JSON.stringify({ csv: 'email\nvictim@example.net\n', mapping: { email: 'email' } }), 15_000);
assert.equal(impVictimRead.status, 200, 'Victim import read must succeed after abandoned unread import reads');
assert.equal(impVictimPrev.status, 201, 'Victim import preview must succeed after abandoned unread import reads');
results.imports = { victimReadMs: impVictimRead.ms, victimPreviewMs: impVictimPrev.ms };

// 4. Multi-round soak of abandoned requests across all three routes (verifies zero cumulative hold leak).
const soak = [];
for (let r = 0; r < soakRounds; r++) {
  const s1 = await openUnread(KEYS.w1, `/v1/attachments/${att1.json.id}/content`, 4);
  const s2 = await openUnread(KEYS.w2, `/v1/template-assets/${ta2.json.id}/content`, 4);
  const s3 = await openUnread(KEYS.w1, `/v1/contact-imports/${imp1}`, 4);
  await sleep(1000);
  for (const s of [...s1, ...s2, ...s3]) s.destroy();
  const [pAtt, pTa, pImp] = await Promise.all([
    apiCall(KEYS.victim, 'GET', `/v1/attachments/${attV.json.id}/content`, undefined, 15_000),
    apiCall(KEYS.victim, 'GET', `/v1/template-assets/${taV.json.id}/content`, undefined, 15_000),
    apiCall(KEYS.victim, 'GET', `/v1/contact-imports/${impV}`, undefined, 15_000),
  ]);
  assert.deepEqual([pAtt.status, pTa.status, pImp.status], [200, 200, 200]);
  soak.push({ round: r + 1, attMs: pAtt.ms, taMs: pTa.ms, impMs: pImp.ms });
}
results.soak = soak;

console.log(JSON.stringify(results, null, 2));
await pool.end();
