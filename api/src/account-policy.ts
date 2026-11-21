import { METHOD_ACR } from './config.js';
import type { Config } from './core.js';

// Who may sign up, decided by the sign-in itself and never by an email address: Anomaly account can assert a
// verified address that the method used to sign in never vouched for (a GitHub-made account that later links a
// personal Google account signs in with acr=google and its GitHub-verified work address).
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

/** Hosted staff, exactly as the account service defines it: a Google sign-in whose Google account has a verified
 * address and belongs to a staff Google Workspace domain (hd, compared exactly). Only Google proves Workspace
 * membership: a GitHub sign-in is never staff, whatever its address. */
export function isStaffSignIn(config: Pick<Config, 'multiTenant' | 'staffGoogleDomains'>, acr: unknown, upstream: ProviderIdentity | null) {
  return config.multiTenant && acr === METHOD_ACR.google
    && upstream?.provider === 'google' && upstream.emailVerified === true && !!upstream.hd && config.staffGoogleDomains.includes(upstream.hd);
}

const googleMail = new Set(['gmail.com', 'googlemail.com']);
/** The address whose mailbox this sign-in proves the person reads now, for what is bound to an address (an invitation,
 * an emailed support request): a Google sign-in's own verified address when Google hosts that mailbox (a Workspace
 * account, or Gmail). GitHub, or a Google account on another provider's address, shows only that an address was
 * verified once. */
export function provenMailbox(acr: unknown, upstream: ProviderIdentity | null) {
  if (acr !== METHOD_ACR.google || upstream?.provider !== 'google' || !upstream.emailVerified || !upstream.email) return null;
  const email = upstream.email.toLowerCase();
  return upstream.hd || googleMail.has(email.slice(email.lastIndexOf('@') + 1)) ? email : null;
}
