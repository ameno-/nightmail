import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/server';

// Bump when an agent must reread instructions (e.g. a new recipient-confirmation rule).
// Do not bump for a wording clarification that leaves the required behavior unchanged.
const INSTRUCTION_VERSION = 1;

// Walk schema positions only. A property named "description", or the literal in a const/default,
// is data. Keep tuple and literal array order; required/enum and union alternatives are sets.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const prose = new Set(['title', 'description', '$comment', 'examples', 'deprecated']);
const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const children = new Set(['additionalProperties', 'unevaluatedProperties', 'items', 'additionalItems', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);
const unions = new Set(['oneOf', 'allOf', 'anyOf']);
function canonical(value: Json, schema = false): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, schema)).join(',') + ']';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return '{' + Object.keys(value).sort().filter(key => !schema || !prose.has(key)).map(key => {
    const child = value[key];
    let text: string;
    if (schema && maps.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
      text = '{' + Object.keys(child).sort().map(name => JSON.stringify(name) + ':' + canonical(child[name], true)).join(',') + '}';
    } else if (schema && Array.isArray(child) && (unions.has(key) || ['enum', 'type', 'required'].includes(key))) {
      text = '[' + child.map(item => canonical(item, unions.has(key))).sort().join(',') + ']';
    } else if (schema && key === 'dependentRequired' && child && typeof child === 'object' && !Array.isArray(child)) {
      text = canonical(Object.fromEntries(Object.entries(child).map(([name, deps]) => [name, Array.isArray(deps) ? [...deps].sort() : deps])));
    } else {
      text = canonical(child, schema && (children.has(key) || key === 'prefixItems'));
    }
    return JSON.stringify(key) + ':' + text;
  }).join(',') + '}';
}

export const fingerprintTag = (text: string) => createHash('sha256').update(text).digest('base64url').slice(0, 16);

// Each fixed-width tag covers ONE name + input contract: an old snapshot remains a subset after an
// addition, without a release registry, previous schemas or a session store. At the catalog's 256
// operation limit plus built-in tools this is under 4.3 KiB. Never used to authorize a request.
export function toolSnapshot(tools: Tool[]): string {
  return tools.map(tool => fingerprintTag(JSON.stringify(tool.name) + ':' + canonical(tool.inputSchema as Json, true))).sort().join('');
}
export const issueLegacySession = (access: string, snapshot: string) =>
  `m1.${INSTRUCTION_VERSION}.${access}.${snapshot}.${crypto.randomUUID().replaceAll('-', '')}`;

export type StaleReason = 'contract_changed' | 'access_changed' | 'version_bumped' | 'malformed_id';
export function staleLegacySession(id: string, access: string, snapshot: string): StaleReason | undefined {
  // Old full-list hashes cannot tell us which inputs a client saw. Refresh once at cutover.
  if (/^[a-f0-9]{16}\.[a-f0-9]{32}$/.test(id)) return 'version_bumped';
  const parsed = id.length <= 4900 && /^m1\.(\d{1,9})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]*)\.([a-f0-9]{32})$/.exec(id);
  if (!parsed || parsed[3].length % 16 !== 0) return 'malformed_id';
  const [, version, previousAccess, held] = parsed;
  if (version !== String(INSTRUCTION_VERSION)) return 'version_bumped';
  if (held === snapshot) return;
  const previous = held.match(/.{16}/g) ?? [];
  if (previous.some((value, i) => i > 0 && value <= previous[i - 1])) return 'malformed_id';
  if (previousAccess !== access) return 'access_changed';
  const current = new Set(snapshot.match(/.{16}/g));
  if (!previous.every(value => current.has(value))) return 'contract_changed';
}
