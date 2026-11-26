// (With extensions: the build's config imports this file, through readable.ts.)
import { productName, publicOrigin } from '../../../../api/src/brand.ts'
import { agentSetupGuide } from '../../../../api/src/agent-setup-guide.ts'

/** What an assistant reading a price page's Markdown copy, llms.txt or llms-full.txt does next, the same line on each:
 *  the setup steps the API keeps for agents, in /docs.md (its Quickstart, and the agent-key guide that /docs/agent-setup
 *  and llms.txt carry too: api/src/agent-setup-guide.ts), the place that ships with every installation whatever its
 *  homepage. It says where to start and how the key comes, not that an account is open: the person approves the agent
 *  from their own account. */
export const START = `To use ${productName} for someone, follow the Quickstart and “${agentSetupGuide.title}” in ${publicOrigin}/docs.md: you get your own API key when that person approves you from their ${productName} account.`
