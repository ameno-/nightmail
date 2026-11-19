import * as aws from '@pulumi/aws';
import { renderBroker } from '../aws-shared/runtime-policies.mjs';

// The one role that assumes a customer's connected-account role (BYO). Only nightmail-runtime enters it, and
// it can do nothing else. Customer stacks trust this account and this role's name, so never rename it.
export function byoBroker(iam: aws.Provider, account: string) {
  const { name, trust, policy } = renderBroker(account);
  const opts = { provider: iam, protect: true };
  const role = new aws.iam.Role(name, {
    name, path: '/', assumeRolePolicy: JSON.stringify(trust), maxSessionDuration: 3600,
    description: 'Assumes the roles of connected AWS accounts for Nightmail',
    tags: { 'nightmail:installation-id': 'nightmail:pool', 'nightmail:owner': 'nightmail', 'nightmail:purpose': 'byo-broker' },
  }, opts);
  new aws.iam.RolePolicy(name, { name: 'connected-account-roles', role: role.name, policy: JSON.stringify(policy) }, opts);
  return role.arn;
}
