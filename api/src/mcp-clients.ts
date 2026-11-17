/**
 * How each MCP client connects to Nightmail's hosted MCP server. One builder for createInboxConnection and the dashboard
 * (Docs and Connect an agent), so every place hands out the same config. It ships to browsers: import only brand.ts.
 *
 * Shapes, as each client documents them:
 * - OpenCode (V2): `mcp.servers.<name>` with `type: "remote"`; `oauth: false` plus `headers` for a key, or an
 *   `oauth.scope` to request. https://opencode.ai/docs/mcp-servers
 * - Claude Code: `.mcp.json` `mcpServers.<name>` with `type: "http"`, or `claude mcp add --transport http`.
 * - Cursor: `.cursor/mcp.json` `mcpServers.<name>` with `url` and optional `headers`.
 */
import { mcpServerName } from './brand.js';

export const mcpClients = ['opencode', 'claude', 'cursor', 'generic'] as const;
export type McpClient = typeof mcpClients[number];
export const mcpClientNames: Record<McpClient, string> = { opencode: 'OpenCode', claude: 'Claude Code', cursor: 'Cursor', generic: 'Other MCP client' };
/** Where the config goes, in the words each client uses. */
export const mcpClientFiles: Record<McpClient, string> = { opencode: 'opencode.json', claude: '.mcp.json', cursor: '.cursor/mcp.json', generic: 'your MCP client’s settings' };

/** The hosted MCP endpoint. Plain /mcp works for every client and grant; no query parameters to explain. */
export const mcpServerUrl = (publicUrl: string) => new URL('/mcp', publicUrl).href;

/**
 * How a config authenticates:
 * - `{ key, env }`: a key the dashboard shows once beside the setup. A config that can sit in a project, and be
 *   committed, names the environment variable `env` instead of the key. Only Claude Code's ~/.claude.json, private to
 *   its user, takes the key itself.
 * - `{ bearer }`: the key itself in any client's config (createInboxConnection returns it once inside the config).
 * - `{ scope }`: OAuth, where the person approves in the browser; scope is what OpenCode asks for.
 */
export type McpAuth = { key: string; env: string } | { bearer: string } | { scope?: string };
const keyed = (auth: McpAuth) => 'key' in auth || 'bearer' in auth;
/** Each client's own way to read an environment variable in its config. */
const envReference = (client: McpClient, env: string) => client === 'opencode' ? `{env:${env}}` : client === 'cursor' ? `\${env:${env}}` : `\${${env}}`;
const authorization = (client: McpClient, auth: McpAuth) => 'bearer' in auth ? `Bearer ${auth.bearer}`
  : 'key' in auth ? `Bearer ${client === 'claude' ? auth.key : envReference(client, auth.env)}` : null;

export function mcpClientConfig(client: McpClient, url: string, auth: McpAuth): Record<string, unknown> {
  const value = authorization(client, auth);
  const headers = value ? { headers: { Authorization: value } } : {};
  if (client === 'opencode') {
    const oauth = value ? { oauth: false } : 'scope' in auth && auth.scope ? { oauth: { scope: auth.scope } } : {};
    return { $schema: 'https://opencode.ai/config.json', mcp: { servers: { [mcpServerName]: { type: 'remote', url, ...oauth, ...headers } } } };
  }
  if (client === 'claude') return { mcpServers: { [mcpServerName]: { type: 'http', url, ...headers } } };
  if (client === 'cursor') return { mcpServers: { [mcpServerName]: { url, ...headers } } };
  return { url, ...headers };
}

/** Claude Code's one-line setup for OAuth. It takes no key: a key on a command line stays in shell history and in
 * the process list, so a key always goes in a JSON config instead (mcpSnippet). */
export const claudeAddCommand = (url: string) => `claude mcp add --transport http ${mcpServerName} ${url}`;

/** What to paste for a client: Claude Code's command for OAuth, otherwise (and always with a key) a JSON config. */
export function mcpSnippet(client: McpClient, url: string, auth: McpAuth): string {
  return client === 'claude' && !keyed(auth) ? claudeAddCommand(url) : JSON.stringify(mcpClientConfig(client, url, auth), null, 2);
}

/** The steps after pasting the config, per client and sign-in. A signed-in client acts as the person, in any of their
 * workspaces: each call names one, else the default. A key read from the environment is set there first. */
export function mcpClientSteps(client: McpClient, auth: McpAuth): string[] {
  if (!keyed(auth)) return [...clientSteps(client, 'oauth'), 'Its tools work in any of your workspaces: name one in your prompt, or it uses your default.'];
  const env = 'key' in auth && client !== 'claude' ? auth.env : null;
  return [...(env ? [`Set ${env} to the key in the environment ${client === 'generic' ? 'your client' : mcpClientNames[client]} runs in.`] : []), ...clientSteps(client, 'key')];
}
function clientSteps(client: McpClient, auth: 'key' | 'oauth'): string[] {
  const file = mcpClientFiles[client];
  if (client === 'opencode') return auth === 'key'
    ? [`Merge this into your project or global ${file}.`, `OpenCode connects on save; /mcps shows ${mcpServerName} as connected.`]
    : [`Merge this into your project or global ${file}.`, `In OpenCode, run /mcps, select ${mcpServerName} and choose Sign in.`, 'Approve the access in your browser.'];
  if (client === 'claude') return auth === 'key'
    ? ['Merge this into the mcpServers of ~/.claude.json, so the key stays out of your project’s history.', `In Claude Code, run /mcp to check that ${mcpServerName} is connected.`]
    : ['Run this in your project’s terminal.', `In Claude Code, run /mcp, select ${mcpServerName} and choose Authenticate.`, 'Approve the access in your browser.'];
  if (client === 'cursor') return auth === 'key'
    ? [`Merge this into ${file} in your project, or ~/.cursor/mcp.json for every project.`, `Cursor Settings → MCP shows ${mcpServerName} as connected.`]
    : [`Merge this into ${file} in your project, or ~/.cursor/mcp.json for every project.`, `In Cursor Settings → MCP, sign in to ${mcpServerName} and approve the access in your browser.`];
  return auth === 'key'
    ? ['Add a remote (Streamable HTTP) server with this URL and Authorization header.']
    : ['Add a remote (Streamable HTTP) server with this URL. Your client signs in with OAuth; approve the access in your browser.'];
}
