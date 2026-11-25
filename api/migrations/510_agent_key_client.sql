SET LOCAL lock_timeout='2s';
-- The client an agent named when it got its key through agent setup (src/agent-setup.ts): its claim, never verified, on
-- the key itself, since the agent_setups row that also has it is removed a day after it expires. It names the key
-- ("OpenCode, set up <date>") and listApiKeys shows it as agent.client, so two agents' keys are told apart.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_client text;
-- Keys made before this kept the claim only in the setup row (gone after a day) and in their audit trail.
UPDATE api_keys k SET agent_client = left(a.summary->'after'->>'client', 100)
FROM audit_events a
WHERE k.agent_setup_id IS NOT NULL AND k.agent_client IS NULL
  AND a.workspace_id = k.workspace_id AND a.target_type = 'api_key' AND a.target_id = k.id AND a.action = 'api_key.create'
  AND a.summary->'after'->>'client' IS NOT NULL;
