import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { readdirSync } from 'node:fs';

// Bring-your-own-AWS setup in the platform account (Ohio): the public bucket customers' CloudFormation reads the role
// templates from, and the SNS topic their stacks report to. Customer stacks name both forever (the template's
// ServiceToken and the role's update permission), so never rename or delete them.
const tag = (purpose: string) => ({ 'nightmail:installation-id': 'nightmail:pool', 'nightmail:owner': 'nightmail', 'nightmail:purpose': purpose });
export function byoSetup(ohio: aws.Provider, account: string, eventsOrigin: string) {
  const keep = { provider: ohio, protect: true };
  // Published templates, one object per api/byo-templates/<version>.yaml, never changed once published (check-premerge.ts).
  const name = `nightmail-byo-templates-${account}`;
  const bucket = new aws.s3.Bucket('byo-templates', { bucket: name, tags: tag('byo-templates') }, keep);
  const ownership = new aws.s3.BucketOwnershipControls('byo-templates-ownership', { bucket: bucket.id, rule: { objectOwnership: 'BucketOwnerEnforced' } }, keep);
  const access = new aws.s3.BucketPublicAccessBlock('byo-templates-access', { bucket: bucket.id, blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: false, restrictPublicBuckets: false }, keep);
  new aws.s3.BucketVersioning('byo-templates-versioning', { bucket: bucket.id, versioningConfiguration: { status: 'Enabled' } }, keep);
  const policy = new aws.s3.BucketPolicy('byo-templates-read', { bucket: bucket.id, policy: JSON.stringify({ Version: '2012-10-17', Statement: [
    { Sid: 'PublicTemplates', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${name}/byo/*` },
  ] }) }, { ...keep, dependsOn: [ownership, access] });
  const dir = new URL('../../api/byo-templates/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => /^\d+\.\d+\.yaml$/.test(f))) {
    new aws.s3.BucketObjectv2(`byo-template-${file}`, { bucket: bucket.id, key: `byo/${file}`, source: new pulumi.asset.FileAsset(new URL(file, dir).pathname),
      contentType: 'text/yaml', cacheControl: 'public, max-age=300' }, { ...keep, retainOnDelete: true, dependsOn: [policy] });
  }
  // Stacks publish their Create, Update and Delete requests here; the Worker verifies each signed notification and
  // proves the role before answering. Any account may publish, since stacks run in customers' accounts.
  const topicName = 'nightmail-byo-setup', topicArn = `arn:aws:sns:us-east-2:${account}:${topicName}`;
  const topic = new aws.sns.Topic(topicName, { name: topicName, tags: tag('byo-setup'), policy: JSON.stringify({ Version: '2012-10-17', Statement: [
    { Sid: 'Owner', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: ['sns:GetTopicAttributes', 'sns:Subscribe', 'sns:ListSubscriptionsByTopic'], Resource: topicArn },
    { Sid: 'CustomerStacks', Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sns:Publish', Resource: topicArn },
  ] }) }, keep);
  new aws.sns.TopicSubscription('byo-setup-https', { topic: topic.arn, protocol: 'https', endpoint: `${eventsOrigin}/v1/events/cloudformation`, rawMessageDelivery: false, endpointAutoConfirms: false }, keep);
  return { templateBase: pulumi.interpolate`https://${bucket.bucket}.s3.us-east-2.amazonaws.com/byo/`, setupTopic: topic.arn };
}
