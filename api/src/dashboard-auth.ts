import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import {ApiError,denied,digest,errors,isSimulatedSes,response,security,type App,type Runtime} from './core.js';
import {accountBrowserRoute,accountSessionActor,accountSessionUser,migrateLegacyCookies,requireDashboardOrigin,settleDefaultAccount} from './account-login.js';
import {Workspace,WorkspaceRole,sessionMemberships} from './workspaces.js';
import {ConnectionSummary,connectionSummary} from './provider-connections.js';
import { clientIpHeader, productName, requestedScopes } from './brand.js';

export async function reserveSignIn(runtime:Runtime,headers:Headers) {
  const peer=await digest(headers.get(clientIpHeader) ?? 'unknown');
  const result=await runtime.db.execute(sql`SELECT reserve_auth_state(${peer}) AS ok`);
  if (!result.rows[0]?.ok) throw new ApiError(429,'AUTH_STATE_LIMIT','Too many pending sign-ins. Try again later.');
}
export async function verifiedDashboardUser(runtime:Runtime,headers:Headers,requireCurrentEmail=false) {
  // A bearer credential (API key, MCP or agent token) never rides the session cookie. It is refused with 403, as on
  // every other dashboard-only route (core.ts); 401 is for a caller with no session at all.
  if (headers.has('authorization')) throw denied('DASHBOARD_AUTH_REQUIRED','Use a signed-in dashboard session.',{credential:'dashboard'});
  const user=await accountSessionUser(runtime,headers,requireCurrentEmail);
  // Signed in, but this session's sign-in proves no mailbox for the account's address (hosted: only a Google-hosted
  // one does, account-policy.ts provenMailbox). What is bound to an address needs a sign-in that does.
  if (!user && requireCurrentEmail && runtime.config.multiTenant && await accountSessionUser(runtime,headers))
    throw new ApiError(403,'MAILBOX_SIGN_IN_REQUIRED','Sign in with the Google account for this email address to continue.');
  if (!user) throw new ApiError(401,'AUTH_REQUIRED',`Sign in to ${productName}.`);
  return {userId:user.id,email:user.email};
}
export async function invitationRecipient(runtime:Runtime,request:Request) {
  requireDashboardOrigin(runtime,request);
  return verifiedDashboardUser(runtime,request.headers,true);
}
export const getDashboardActor = accountSessionActor;
export { migrateLegacyCookies, requireDashboardOrigin, settleDefaultAccount };
export function registerDashboardAuth(app: App) {
  app.on(['GET','POST','OPTIONS'],'/api/auth/*',accountBrowserRoute);
  app.openapi(createRoute({method:'get',path:'/v1/me',operationId:'getCurrentIdentity',tags:['Auth'],security,
    responses:{200:response(z.object({id:z.string(),workspaceId:z.string(),role:WorkspaceRole.nullable(),multiTenant:z.boolean(),simulated:z.boolean(),email:z.string().nullable(),name:z.string().nullable(),permissions:z.array(z.enum(['read','send','manage'])),domains:z.array(z.string()),origin:z.string().url(),host:z.string(),mcpScopes:z.array(z.string()).openapi({description:'The OAuth scopes this installation\'s MCP server asks for, for read, send and manage (nightmail:read …, or bane:read … until the account service supports nightmail:*).'}),connection:ConnectionSummary.nullable().openapi({description:'The current workspace\'s hosted sending connection; null when self-hosted.'}),workspaces:z.array(Workspace).nullable().openapi({description:'A hosted dashboard session\'s workspaces and roles (select one with X-Nightmail-Workspace); null for keys, MCP, agent tokens and self-hosted.'}),operator:z.enum(['operator','operator:read']).nullable().optional().openapi({description:`${productName} staff only: the platform operator role of this dashboard session (it opens /operator). Null for everyone else, and for a session that didn't sign in with Google.`}),staffSignIn:z.boolean().optional().openapi({description:`${productName} staff only: true when this person holds an operator role but this session didn't sign in with Google, which staff tools need. False otherwise.`}),uiNotes:z.boolean().optional().openapi({description:`${productName} staff only: this session may use staff UI notes. False for everyone else.`}),analytics:z.boolean().optional().openapi({description:'Whether this installation records how its dashboard is used (DASHBOARD_ANALYTICS). The dashboard sends nothing when false.'}),byo:z.boolean().optional().openapi({description:'Hosted dashboard sessions: an operator lets this workspace connect its own AWS account (POST /v1/connection with kind byo). False otherwise, and the dashboard offers Hosted mail only.'}),
      billing:z.object({enforcement:z.enum(['off','shadow','enforce']),free:z.boolean().describe('Anomaly made this workspace free: never charged or paused for the balance.'),sending:z.enum(['ok','low','paused']),receiving:z.enum(['ok','grace','held']),autoRecharge:z.enum(['off','on','pending','failed','capped'])})
        .nullable().optional().openapi({description:'Hosted dashboard sessions: whether the workspace is free, whether an empty balance has paused sending or held received mail, and auto-recharge, so the dashboard can show it on its first frame. Null otherwise; GET /v1/billing has the detail.'}),
      mailServers:z.object({imap:z.string(),smtp:z.string()}).nullable().optional().openapi({description:'The hosts mail apps connect to: IMAP on 993 (TLS) or 143 (STARTTLS), SMTP on 465 (TLS) or 587 (STARTTLS). An app password signs in to both; a send-only API key signs in to SMTP as apikey. Null when this installation has no IMAP/SMTP gateway.'})})),...errors}}),async c=>{
    const identity=c.get('actor'), userId=identity.keyId.startsWith('user_')?identity.keyId.slice(5):null;
    const origin=new URL(c.env.config.publicUrl).origin, hosted=c.env.config.multiTenant;
    // Independent reads run together; the UI-notes and billing reads depend on the session, so they follow it.
    const [connection,session]=await Promise.all([hosted?connectionSummary(c.env,identity.workspaceId):null,
      hosted && identity.credential==='dashboard' && userId?sessionMemberships(c.env.db,userId):null]);
    // One statement (billing_position and the account row), only for hosted dashboard sessions: the banner's first frame.
    // Staff UI notes: an operator in UI_NOTES_SUBJECTS only (operator-identity.ts); no query when the list is empty.
    const [uiNotes,billing,byo]=await Promise.all([
      session?.operator==='operator' && identity.staff && userId ? import('./operator-identity.js').then(({uiNotesAllowed})=>uiNotesAllowed(c.env.db,c.env.config.uiNotesSubjects,userId)) : false,
      session?import('./billing/state.js').then(async({readBilling})=>{const b=await readBilling(c.env.db,identity.workspaceId,{amounts:false,received:false});return {enforcement:b.enforcement,free:b.mode==='exempt',...b.state};}):null,
      session?import('./byo-pilot.js').then(({byoEnabled})=>byoEnabled(c.env,identity.workspaceId)):false]);
    return c.json({id:userId??identity.keyId,workspaceId:identity.workspaceId,role:WorkspaceRole.nullable().parse(identity.role??null),multiTenant:hosted,simulated:isSimulatedSes(c.env),email:identity.email??null,name:identity.name??null,permissions:identity.permissions,domains:identity.domains,origin,host:new URL(origin).host,mcpScopes:requestedScopes(c.env.config),connection,workspaces:session?.workspaces??null,operator:identity.staff?session?.operator??null:null,staffSignIn:!!session?.operator&&!identity.staff,uiNotes,byo,analytics:c.env.config.dashboardAnalytics===true,billing,mailServers:c.env.config.mailServers??null},200);
  });
}
