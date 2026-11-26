import { apiKeyEnv, productName, publicOrigin, secretPrefixes } from './brand.js'
/**
 * How a coding agent gets its own API key (src/agent-setup.ts): the setup token in a prompt a person copied, or a device
 * code a person approves. Shared by the dashboard's Docs guide (/docs/agent-setup) and the API's /docs.md and /llms.txt,
 * so it has no runtime imports and ships to browsers.
 */
export const agentSetupGuide = {
  id: 'agent-setup',
  title: 'Give a coding agent its own key',
  summary: 'A setup token in the prompt you copy, or a code you approve: the agent gets its own key, which can\'t create other keys or passwords, or reach members or billing.',
  text: `A coding agent gets its own API key without one made by hand, in one of two ways. The prompt is the quicker: the person copies it where they already are and the agent connects in seconds, while a device code waits for the person to open a link the agent shows somewhere else. With the prompt: when an owner or admin copies the agent prompt in the dashboard (onboarding, Docs or Connect an agent), the copy carries a one-time setup token (${secretPrefixes.agentSetup}…) that works for 15 minutes, and the agent exchanges it with POST /v1/agent/setup. Copying again replaces an unused token. An expired or replaced token answers 410 with a device code in error.details[0] for the person who copied it to approve, and their dashboard shows the agent waiting. Without it (RFC 8628 device flow): POST /v1/agent/device returns a device_code, a user_code and verification_uri_complete; show the person that link on its own line (nextStep says so) and they open it (${productName}'s /connect page), signs in, checks the code, chooses the workspace and approves; meanwhile the agent polls POST /v1/agent/device/token every interval seconds. 400 AUTHORIZATION_PENDING means keep waiting, SLOW_DOWN wait five seconds longer from now on, ACCESS_DENIED stop, and EXPIRED_TOKEN that nobody approved in time: the first carries a new code in error.details[0] (once), after that start again. Each pending answer repeats the link. Either way the agent gets one key, named after its client_name ("My agent, set up <date>"): read, send and manage on every domain, so it sends email and manages domains, inboxes, receiving, webhooks, audience and campaigns. It can't create API keys, agent tokens, inbox connection keys, inbox keys or mail-client (IMAP/SMTP) passwords, and never reaches members or billing: it works with inboxes through its own key. It is shown once: keep it as ${apiKeyEnv} in the project's environment, never in code. Asked again, the setup token or device code answers 409 naming the key it gave (error.details), never a second key. A revoked key answers 401 KEY_REVOKED: run setup again. The response also has an MCP config that reads it from there. A person revokes it under API keys, and Activity names who set it up.`,
  language: 'sh',
  code: `# With the setup token in the prompt:
curl -sS -X POST ${publicOrigin}/v1/agent/setup -H 'Content-Type: application/json' \\
  -d '{"token":"${secretPrefixes.agentSetup}…","client_name":"My agent"}'

# Without one: start the device flow and show the person verification_uri_complete and user_code ...
curl -sS -X POST ${publicOrigin}/v1/agent/device -H 'Content-Type: application/json' -d '{"client_name":"My agent"}'
# ... then poll every interval seconds until it returns the key.
curl -sS -X POST ${publicOrigin}/v1/agent/device/token -H 'Content-Type: application/json' \\
  -d '{"device_code":"${secretPrefixes.deviceCode}…"}'`,
};
