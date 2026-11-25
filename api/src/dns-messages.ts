// What DNS problems are called, word for word, wherever they are shown: the domain page, the background check and the setup
// reminder. No imports, so the dashboard and the notices both use it.

export type WildcardSeen = { wildcard: string; parking?: { owner: string; target: string } };
/**
 * Something other than the domain's own CNAMEs answers their names (record-check.ts withPublicDns): a registrar's parking
 * or forwarding record (Porkbun's * → pixie.porkbun.com), or another wildcard. `host`: the domain's DNS provider, when known.
 */
export const wildcardMessage = ({ wildcard, parking }: WildcardSeen, host: string | null | undefined) => parking
  ? `Your DNS still has ${parking.owner}’s parking/wildcard record (${wildcard} → ${parking.target}). Add these CNAME records explicitly; the specific records take priority.`
  : `A wildcard record (${wildcard}) is answering for these names. Add the CNAME records exactly; ${host ?? 'your DNS provider'} uses the specific record over the wildcard.`;
