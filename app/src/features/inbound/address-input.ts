// What a person types into an address field, read the way they meant it (the address builder's first step).
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
export type Understood = { address: string; displayName?: string; note?: string; error?: string; code?: string; fixes?: string[] }
/**
 * What a person typed as an address, read the way they meant it: an address pasted with its name (Name <address>), a name
 * alone or name@ (at the workspace's first host; the others offered), a name with spaces (dots instead), and capitals
 * and stray spaces (dropped silently). A guess comes back with a note saying what changed; what can't be read (a domain
 * alone, or @domain) comes back as an error with the address it likely meant. Whether the address is allowed is not
 * decided here: the builder's checks and the API do that.
 */
export function understandAddress(raw: string, hosts: string[], domains: string[] = hosts): Understood {
  let text = raw.trim(), displayName: string | undefined
  const notes: string[] = []
  const pasted = /^(.*?)\s*<\s*([^<>]+?)\s*>$/.exec(text)
  if (pasted) { text = pasted[2]!; displayName = pasted[1]!.trim().replace(/^"(.*)"$/, '$1') || undefined; notes.push(displayName ? `Took the address; ${displayName} is its name.` : 'Took the address.') }
  const lower = text.toLowerCase(), at = lower.lastIndexOf('@')
  const local = (at < 0 ? lower : lower.slice(0, at)).trim(), host = at < 0 ? '' : lower.slice(at + 1).trim()
  // A domain alone, or @domain: the part before the @ is missing.
  if ((at < 0 && DOMAIN.test(local) && domains.some(d => local === d || local.endsWith(`.${d}`))) || (at === 0 && host)) {
    const domain = at < 0 ? local : host
    return { address: lower, error: `Add a name before the @, such as support@${domain}.`, code: 'missing_local', fixes: [`support@${domain}`] }
  }
  const dotted = local.replace(/\s+/g, '.')
  if (dotted !== local) notes.push('Spaces became dots.')
  if (!host) {
    if (!dotted || !hosts[0]) return { address: lower, ...(displayName ? { displayName } : {}) }
    notes.push(`Added @${hosts[0]}.`)
    return { address: `${dotted}@${hosts[0]}`, ...(displayName ? { displayName } : {}), note: notes.join(' '), fixes: hosts.slice(1, 4).map(h => `${dotted}@${h}`) }
  }
  return { address: `${dotted}@${host}`, ...(displayName ? { displayName } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) }
}
