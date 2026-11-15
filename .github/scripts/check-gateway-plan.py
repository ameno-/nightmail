"""During adoption, only the four containers and the consuming ECS rollout may change."""
import json
import sys

stage, path = sys.argv[1:]
with open(path) as source:
    resources = json.load(source)["resourcePlans"]

prefix = f"urn:pulumi:{stage}::bane::"
secret_op = "import" if stage == "dev" else "create"
containers = {
    prefix + "aws:secretsmanager/secret:Secret::nightmail-mail-gateway-" + key
    for key in ("db-url", "tls-cert", "tls-key", "api-token")
}
allowed = {urn: {secret_op} for urn in containers}
allowed.update({
    prefix + "aws:ecs/taskDefinition:TaskDefinition::bane-mail-gateway": {
        "replace", "create-replacement", "delete-replaced",
    },
    prefix + "aws:iam/rolePolicy:RolePolicy::bane-mail-gateway-execution": {"update"},
    prefix + "aws:ecs/service:Service::bane-mail-gateway": {"update"},
})
changes = {urn: set(plan.get("steps") or []) - {"same", "read"} for urn, plan in resources.items()}
if not containers <= changes.keys():
    sys.exit("gateway containers missing from preview")
if any(changes[urn] for urn in containers):
    for urn, ops in changes.items():
        if ops - allowed.get(urn, set()):
            sys.exit(f"unexpected gateway migration change: {urn}: {sorted(ops)}")

# First production mail preparation (including retries of a partial apply) may only
# add the inactive #256 mail path. Never mix it with a live resource update.
mail = {
    'aws:s3/bucket:Bucket::nightmail-mail',
    'aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock::nightmail-mail-private',
    'aws:s3/bucketPolicy:BucketPolicy::nightmail-mail-policy',
    'aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration::nightmail-mail-retention',
    'aws:ses/receiptRuleSet:ReceiptRuleSet::nightmail-inbound',
    'aws:ses/receiptRule:ReceiptRule::nightmail-inbound-all',
    *(f'aws:sns/topic:Topic::nightmail-alerts-{r}' for r in ('us-east-1','us-east-2')),
}
for topic in ('nightmail-inbound', 'nightmail-feedback', 'nightmail-trusted-feedback'):
    dlq = topic + '-dead-letters'
    mail.update({f'aws:sns/topic:Topic::{topic}', f'aws:sqs/queue:Queue::{dlq}',
                 f'aws:sqs/queuePolicy:QueuePolicy::{dlq}-policy', f'aws:cloudwatch/metricAlarm:MetricAlarm::{dlq}'})
mail = {prefix + suffix for suffix in mail}
if stage == 'production' and any('create' in changes.get(urn, set()) for urn in mail):
    if not mail <= changes.keys():
        sys.exit('incomplete production mail staging plan')
    for urn, ops in changes.items():
        if ops and (urn not in mail or ops != {'create'}):
            sys.exit(f'unexpected production mail staging change: {urn}: {sorted(ops)}')
