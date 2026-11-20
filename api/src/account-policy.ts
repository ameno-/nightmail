import { METHOD_ACR } from './config.js';
import type { Config } from './core.js';

// Who may sign up, decided by the sign-in itself and never by the account's own email address: Anomaly account can
// assert a verified address that the method used to sign in never vouched for (a GitHub-made account that later links
// a personal Google account signs in with acr=google and its GitHub-verified work address).
//
// Anomaly account's claim for the provider identity behind this sign-in: {provider, sub, email, email_verified, hd?}
// from the provider used for this sign-in, omitted when there is none. Requested as an essential ID-token claim.
export const PROVIDER_IDENTITY_CLAIM = 'https://account.anoma.ly/claims/upstream';

export type ProviderIdentity = { provider: string; sub: string; email: string | null; emailVerified: boolean; hd: string | null };

/** The provider identity behind this sign-in, from a verified ID token or a subject-checked UserInfo response. */
export function providerIdentity(source: Record<string, unknown> | null | undefined): ProviderIdentity | null {
  const value = source?.[PROVIDER_IDENTITY_CLAIM];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.provider !== 'string' || typeof p.sub !== 'string' || !p.provider || !p.sub) return null;
  return { provider: p.provider, sub: p.sub, email: typeof p.email === 'string' ? p.email : null, emailVerified: p.email_verified === true,
    hd: typeof p.hd === 'string' && p.hd ? p.hd : null };
}

const methodNames: Record<string, string> = { [METHOD_ACR.github]: 'GitHub', [METHOD_ACR.google]: 'Google' };
/** The accepted sign-in methods by name ("GitHub or Google"); null when one isn't the account service's. */
export function acceptedMethods(acr: readonly string[] | undefined) {
  const names = acr?.map(value => methodNames[value]);
  return names?.length && names.every(Boolean) ? [...new Set(names)].sort().join(' or ') : null;
}

/** The staff domain the provider behind this sign-in vouches for: a Google account's Workspace domain (hd, compared
 * exactly), or the domain of GitHub's address, which the account service passes on only when it is the GitHub
 * account's primary, verified address. Nothing for another provider, or without the provider's verified address. */
function providerDomain(upstream: ProviderIdentity) {
  if (!upstream.emailVerified) return null;
  if (upstream.provider === 'google') return upstream.hd;
  if (upstream.provider === 'github') return upstream.email?.slice(upstream.email.lastIndexOf('@') + 1).toLowerCase() || null;
  return null;
}

/** Hosted staff, exactly as the account service defines it: a GitHub or Google sign-in (the acr names the provider
 * whose identity the claim carries) whose provider vouches for a staff domain (AUTH_STAFF_DOMAINS). */
export function isStaffSignIn(config: Pick<Config, 'multiTenant' | 'staffDomains'>, acr: unknown, upstream: ProviderIdentity | null) {
  if (!config.multiTenant || !upstream || !Object.hasOwn(METHOD_ACR, upstream.provider) || acr !== METHOD_ACR[upstream.provider as keyof typeof METHOD_ACR]) return false;
  const domain = providerDomain(upstream);
  return !!domain && config.staffDomains.includes(domain);
}
