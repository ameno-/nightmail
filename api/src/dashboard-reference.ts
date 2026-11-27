// Exclude an operation from the public reference only when its handler requires a dashboard session:
// no API key, agent token or MCP sign-in can pass its guard. Low or zero traffic is never a reason
// to hide, date or remove an operation. The registered routes and SDK retain every one of these.
export const dashboardReference: ReadonlyMap<string, string | null> = new Map([
  ['bindMcpConnection', null],
  ['listAgents', null],
  ['revokeAgent', null],
  ['createAgentSetupToken', '/docs/agent-setup'],
  ['getAgentSetupToken', '/docs/agent-setup'],
  ['lookUpAgentDevice', '/docs/agent-setup'],
  ['listWaitingAgentDevices', '/docs/agent-setup'],
  ['approveAgentDevice', '/docs/agent-setup'],
  ['denyAgentDevice', '/docs/agent-setup'],
  ['sendDomainTestEmail', null],
  ['getDomainDnsSetup', null],
  ['releaseSenderStanding', null],
  ['createWorkspace', null],
  ['renameCurrentWorkspace', null],
  ['updateWorkspaceMember', null],
  ['removeWorkspaceMember', null],
  ['getWorkspaceInvitation', null],
  ['acceptWorkspaceInvitation', null],
  ['getConnection', null],
  ['createConnection', null],
  ['deleteConnection', null],
  ['listConnectionRegions', null],
  ['refreshConnectionScan', null],
  ['importConnectionDomains', null],
  ['requestConnectionProductionAccess', null],
  ['updateConnectionStack', null],
  ['getConnectionRegionStatus', null],
  ['verifyConnection', null],
  ['contactSupport', null],
  ['createBillingTopUp', null],
  ['updateBillingAutoRecharge', null],
  ['createBillingCardSetup', null],
  ['deleteBillingPaymentMethod', null],
]);

// The build no longer emits these files. On an asset miss, answer before falling back to the shell.
// Markdown twins have the same disposition as their HTML pages.
export function oldDashboardReference(pathname: string): Response | undefined {
  const match = /^\/docs\/(?:api\/([A-Za-z0-9]+)(?:\.html)?|operations\/([A-Za-z0-9]+)\.md)\/?$/.exec(pathname);
  if (!match) return;
  const destination = dashboardReference.get(match[1] ?? match[2]);
  if (destination === undefined) return;
  const headers = new Headers({ 'cache-control': 'public, max-age=3600' });
  if (destination) headers.set('location', destination);
  return new Response(null, { status: destination ? 301 : 410, headers });
}
