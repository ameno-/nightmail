import { ApiError } from './core.js';
import { setupResources } from './ses-setup.js';

/** Why a connected account's role is assumed: the session's name is nightmail-<purpose>. */
export type ByoPurpose = 'scan' | 'provision' | 'cleanup' | 'send' | 'template' | 'quota' | 'verify' | 'read' | 'delete' | 'mailfrom';
export type ByoScope = { region: string; account: string; connectionId: string; domain?: string; template?: string };
type Statement = { Effect: 'Allow'; Action: string[]; Resource: string | string[]; Condition?: { StringEquals: Record<string, string> } };
const domainName = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/;

/**
 * The only place a connected account's session policies are written. Each session is narrowed to one purpose, so
 * the role's broader namespace grants are never handed out whole. The acceptance test "BYO contract" checks every
 * statement here against every supported role template (api/byo-template.yaml and api/byo-templates/).
 */
export function byoSessionStatements(purpose: ByoPurpose, s: ByoScope): Statement[] {
  const names = setupResources(s.connectionId, 'byo'), ses = `arn:aws:ses:${s.region}:${s.account}:`;
  const sets = [names.transactional, names.marketing].map(n => ses + 'configuration-set/' + n), topic = `arn:aws:sns:${s.region}:${s.account}:${names.topicName}`;
  const allow = (Action: string[], Resource: string | string[], extra: Record<string, string> = {}): Statement => ({ Effect: 'Allow', Action, Resource, Condition: { StringEquals: { 'aws:RequestedRegion': s.region, ...extra } } });
  const domain = () => {
    if (!s.domain || !domainName.test(s.domain)) throw new ApiError(409, 'BYO_SESSION_SCOPE_REQUIRED', 'A purpose-scoped regional AWS session is required.');
    return ses + 'identity/' + s.domain;
  };
  // Domain sessions name one identity and no region condition, as before this module.
  const identity = (actions: string[]): Statement[] => [{ Effect: 'Allow', Action: ['ses:GetEmailIdentity', ...actions], Resource: domain() }];
  switch (purpose) {
    case 'scan': return [allow(['ses:GetAccount', 'ses:ListEmailIdentities', 'ses:ListConfigurationSets', 'ses:DescribeActiveReceiptRuleSet'], '*'), allow(['ses:GetEmailIdentity'], ses + 'identity/?*.??*'),
      allow(['ses:GetConfigurationSet'], [...sets, ses + 'configuration-set/bane-*', ses + 'configuration-set/nightmail-*'])];
    case 'provision': return [allow(['ses:GetAccount'], '*'),
      allow(['ses:GetConfigurationSet', 'ses:CreateConfigurationSet', 'ses:TagResource', 'ses:PutConfigurationSetSuppressionOptions', 'ses:GetConfigurationSetEventDestinations', 'ses:CreateConfigurationSetEventDestination'], sets),
      allow(['sns:CreateTopic', 'sns:TagResource', 'sns:GetTopicAttributes', 'sns:ListTagsForResource', 'sns:SetTopicAttributes', 'sns:ListSubscriptionsByTopic', 'sns:GetSubscriptionAttributes', 'sns:Subscribe'], topic)];
    case 'cleanup': return [allow(['ses:GetConfigurationSet', 'ses:GetConfigurationSetEventDestinations', 'ses:DeleteConfigurationSet'], sets),
      allow(['sns:GetTopicAttributes', 'sns:ListTagsForResource', 'sns:ListSubscriptionsByTopic', 'sns:GetSubscriptionAttributes', 'sns:DeleteTopic'], topic)];
    case 'send': return [allow(['ses:SendEmail'], [domain(), ...sets], { 'ses:ApiVersion': '2' }), allow(['ses:ApplyTrackingConfigurationOverrides'], '*', { 'ses:OpenTrackingEnabled': '${ses:ClickTrackingEnabled}' })];
    case 'template':
      if (!s.template || !/^bane-[A-Za-z0-9_-]+$/.test(s.template)) throw new ApiError(422, 'TEMPLATE_SCOPE_REQUIRED', 'Regional BYO may render only bane- templates.');
      return [allow(['ses:GetEmailTemplate', 'ses:TestRenderEmailTemplate'], ses + 'template/' + s.template)];
    case 'quota': return [allow(['ses:GetAccount'], '*')];
    case 'read': return identity([]);
    case 'verify': return identity(['ses:CreateEmailIdentity', 'ses:TagResource']);
    case 'delete': return identity(['ses:DeleteEmailIdentity']);
    case 'mailfrom': return identity(['ses:PutEmailIdentityMailFromAttributes']);
  }
}
export const byoSessionPolicy = (purpose: ByoPurpose, scope: ByoScope) => JSON.stringify({ Version: '2012-10-17', Statement: byoSessionStatements(purpose, scope) });
