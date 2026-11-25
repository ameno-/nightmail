// What DNS problems are called, word for word, wherever they are shown: the domain page, the background check and the setup
// reminder. No imports, so the dashboard and the notices both use it.

/** A wildcard (`*.<domain>`) answers a domain's missing CNAMEs with an address (record-check.ts withPublicDns). `host`: its DNS provider, when known. */
export const wildcardMessage = (wildcard: string, host: string | null | undefined) =>
  `A wildcard record (${wildcard}) is answering for these names. Add the CNAME records exactly; ${host ?? 'your DNS provider'} uses the specific record over the wildcard.`;
