// Makes NIGHTMAIL_POSTMASTER_CREDENTIALS: an OAuth grant (postmaster.readonly) for Glass's Gmail Postmaster Tools reads
// (src/glass-deliverability.ts). Needs a Google Cloud project with the Gmail Postmaster Tools API enabled and a
// "Desktop app" OAuth client in it. Sign in as the Google account that verified the domains in Postmaster Tools.
//   POSTMASTER_CLIENT_ID=… POSTMASTER_CLIENT_SECRET=… node --import tsx scripts/postmaster-auth.ts <out.json>
// It prints a consent link, waits for Google to send the browser back to 127.0.0.1, writes {clientId, clientSecret,
// refreshToken} to <out.json> (mode 0600, never printed) and lists the domains the grant can read. Set the file's contents
// as the Worker secret: wrangler secret put NIGHTMAIL_POSTMASTER_CREDENTIALS < out.json
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const out = process.argv[2], clientId = process.env.POSTMASTER_CLIENT_ID, clientSecret = process.env.POSTMASTER_CLIENT_SECRET;
if (!out || !clientId || !clientSecret) throw new Error('Usage: POSTMASTER_CLIENT_ID=… POSTMASTER_CLIENT_SECRET=… node --import tsx scripts/postmaster-auth.ts <out.json>');
const base64url = (bytes: Buffer) => bytes.toString('base64url'), state = base64url(randomBytes(16)), verifier = base64url(randomBytes(48));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const server = createServer();
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/postmaster.readonly',
  access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })) consent.searchParams.set(k, v);
console.log(`Open this link and allow read access to Postmaster Tools:\n${consent.href}`);

const code = await new Promise<string>((resolve, reject) => server.on('request', (req, res) => {
  const url = new URL(req.url ?? '/', redirect);
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'Done. You can close this tab.' : 'Refused: try the link again.');
  if (ok) resolve(url.searchParams.get('code')!); else reject(new Error(url.searchParams.get('error') ?? 'The answer did not match this request.'));
}));
server.close();
const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect,
  grant_type: 'authorization_code', code_verifier: verifier }) });
const token = await res.json() as { access_token?: string; refresh_token?: string; error?: string };
if (!res.ok || !token.refresh_token) throw new Error(`Google gave no refresh token (${token.error ?? res.status}).`);
writeFileSync(out, JSON.stringify({ clientId, clientSecret, refreshToken: token.refresh_token }), { mode: 0o600 });
const domains = await (await fetch('https://gmailpostmastertools.googleapis.com/v1/domains', { headers: { authorization: `Bearer ${token.access_token}` } })).json() as { domains?: { name: string }[] };
console.log(`Wrote ${out}. Domains this grant reads: ${(domains.domains ?? []).map(d => d.name.replace(/^domains\//, '')).join(', ') || 'none'}`);
