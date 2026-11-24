// A deterministic successful request on each real auth path. Scenarios are benchmark drivers;
// they receive the same disposable Postgres, object store and issuer as the acceptance fixtures.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createApp } from '../src/app.js';
import { ensureRegionSettings } from '../src/ses-region-state.js';
import { nodeRuntime } from '../src/adapters/node.js';
import { observeSample } from '../src/adapters/roundtrips.mjs';

const env = process.env;
const local = s => {const u = new URL(s); return ['127.0.0.1','localhost','[::1]'].includes(u.hostname) && !u.search && !u.hash;};
if (!env.NIGHTMAIL_ROUNDTRIPS?.startsWith('/') || !env.NIGHTMAIL_ROUNDTRIPS_SCENARIO?.startsWith('/') || env.ENABLE_LIVE_SES !== 'false' ||
    ![env.DATABASE_URL, env.PUBLIC_URL, env.S3_ENDPOINT, env.ACCOUNT_ISSUER].every(local) || new URL(env.DATABASE_URL).pathname !== '/fixture') throw Error('Use lab acc with a fresh loopback fixture');
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw Error('External requests are disabled in this benchmark');
  return originalFetch(input, init);
};
const { default: run, modes = ['cookie','key'], poolSize = 1 } = await import(pathToFileURL(env.NIGHTMAIL_ROUNDTRIPS_SCENARIO));
if (![1,4].includes(poolSize) || !modes.every(m => ['cookie','key','protocol'].includes(m))) throw Error('Use HTTP pool 1 or support RPC pool 4 with a declared auth mode');
const db = new pg.Client({connectionString: env.DATABASE_URL}); await db.connect();
const hash = s => createHash('sha256').update(s).digest('hex');
try {
  for (const auth of modes) {
    const wid = 'rt_'+randomUUID().replaceAll('-',''), userId = 'usr_'+randomUUID().replaceAll('-','');
    const tok = randomBytes(32).toString('base64url'), cookie = 'nightmail.session_token='+tok, key = 'nm_'+randomBytes(32).toString('hex');
    const email = userId+'@example.test';
    // Match seedSession's subject, expiry and membership; the key goes through normal bearer auth/budget.
    await db.query('INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$1,$1,$2)',[wid,'Synthetic fixture address']);
    await db.query('INSERT INTO operation_settings(workspace_id,name,postal_address) VALUES ($1,$1,$2)',[wid,'Synthetic fixture address']);
    await db.query('INSERT INTO nightmail_users(id,name,email,email_verified,mailbox_proved,mailbox_proved_at) VALUES ($1,$1,$2,true,$2,now())',[userId,email]);
    await db.query('INSERT INTO nightmail_oidc_identities(issuer,subject,user_id) VALUES ($1,$2,$2)',[env.ACCOUNT_ISSUER,userId]);
    await db.query("INSERT INTO nightmail_sessions(token_hash,user_id,issuer,subject,verified_email,expires_at) VALUES($1,$2,$3,$2,$4,now()+interval '1 hour')",[hash(tok),userId,env.ACCOUNT_ISSUER,email]);
    await db.query("INSERT INTO workspace_members(id,user_id,workspace_id,role) VALUES ($1,$2,$3,'owner')",[randomUUID(),userId,wid]);
    await db.query("INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,'benchmark',$3,'nm_fixture','[\"manage\",\"read\",\"send\"]','[]')",['key_'+randomUUID().replaceAll('-',''),wid,hash(key)]);
    const {runtime,close}=nodeRuntime({...env, MULTI_TENANT:'true', DEFAULT_SES_REGION:'us-east-2', ENABLE_LIVE_SES:'false'});
    const pool = new pg.Pool({connectionString:env.DATABASE_URL, max:poolSize});
    runtime.db=drizzle(pool); runtime.config.workspaceId=wid;
    await ensureRegionSettings(runtime.db,runtime.config);
    runtime.webhookFetch=async()=>{ throw Error('External webhook delivery is disabled in this benchmark'); };
    const app=createApp(), origin=env.PUBLIC_URL;
    const call = (method,path,opts={}) => {
      if (!path.startsWith('/') || path.startsWith('//')) throw Error('Pass an application path');
      const mode=opts.auth??auth, headers = new Headers({origin, 'x-nightmail-workspace':wid,...(mode==='cookie'?{cookie}:mode==='key'?{authorization:'Bearer '+key}:{}), ...opts.headers});
      let body=opts.raw;
      if(opts.body!==undefined){body=JSON.stringify(opts.body); headers.set('content-type','application/json');}
      const req=new Request(origin+path,{method,headers,body});
      return observeSample(opts.label??'usual',()=>app.fetch(req,opts.runtime??runtime));
    };
    const json = async (method,path,opts={}) => {
      const r = await call(method,path,opts);
      if (!r.ok) { const code = (await r.json().catch(()=>null))?.error?.code; throw Error('Benchmark '+(opts.label??'usual')+' '+method+' '+r.status+' '+(code??'')); }
      return r.status===204 ? undefined : r.json();
    };
    try { await run({ auth,wid,userId,key,cookie,db,app,runtime,call,json,origin,observeSample,load:(name)=>import(new URL(name, new URL('../src/',import.meta.url)).href) }); }
    finally { await pool.end(); await close(); }
  }
} finally { await db.end(); }
