// (With extensions: the build's config imports this file, home-tv.ts.)
import { apiKeyEnv, productName, publicOrigin, sdkPackage } from '../../../../../api/src/brand.ts'
import * as factory from '../../pricing/readable.ts'
import { formatCount, listOf, nightmail } from '../../pricing/prices.ts'
import { ASSUME, MONTHS, OPENING, RIVALS, usd, VOLUMES } from './data.ts'
import { DESCRIPTION, LEAD, QUESTIONS, TITLE } from './said.ts'

// What the public pages say for readers that aren't browsers (pricing/readable.ts) when the homepage is the television
// (VITE_HOME=tv: home-tv.ts, and price-pages.ts for the files it writes). Its Markdown twin leads with the price of
// sending, then has the steps its "Copy for your agent" points agents to and the comparison its tape plays; the product
// in every page's structured data is pitched on that price, sent or received; the rest is the factory homepage's.
export { jsonLd } from '../../pricing/readable.ts'

const url = (path: string) => publicOrigin + path
const { table, trademarks } = factory

/** The billing code's price, for mail sent and received, with both free allowances. */
const pricePitch = () => `${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month`

/** The homepage's steps for an agent asked to set up sending (its "Copy for your agent" points here): the device flow for
 *  its own key (api/src/agent-setup.ts, the same one the dashboard's agent prompt falls back to), the docs, a first send
 *  from the workspace's built-in domain (api/src/builtin-domain.ts) and the person's own domain after it. */
function agentSteps() {
  return [
    `## For agents: set up sending`,
    `If a person asked you to send email from their project with ${productName}:`,
    [
      `1. Get your own API key. Quickest: ask the person to sign in (or sign up) at ${url('/docs#agent-prompt')}, press Copy agent prompt and paste it to you; its one-time setup token gets your key from POST ${url('/v1/agent/setup')} in seconds. Otherwise use a device code: POST ${url('/v1/agent/device')} with the JSON body {"client_name":"<your name>"}. Show the person its verification_uri_complete as a link on its own line and ask them to open it and approve you, with its user_code; they sign in there (a new account signs up the same way). Poll POST ${url('/v1/agent/device/token')} with {"device_code":"<device_code>"} every interval seconds until it returns the key (AUTHORIZATION_PENDING means keep waiting; show the link again if they haven't approved).`,
      `2. Save the key as ${apiKeyEnv} in the project's environment (a gitignored .env), never in code or a commit: it's shown once.`,
      `3. Read ${url('/llms.txt')} and ${url('/docs.md')} before writing code. Use the TypeScript SDK (npm i ${sdkPackage}) or the REST API with the key as a bearer token, from server code only.`,
      `4. Send from the workspace's domain (GET /v1/domains lists it). A new workspace starts with a built-in nightmail.email domain that for now sends only to its members' own sign-in addresses, so send the first email to the person's own address with POST /v1/emails/send. 202 means queued, not delivered.`,
      `5. To email anyone else, ask the person which domain to send from, add it with POST /v1/domains and give them its DNS records; it verifies by itself once they resolve.`,
    ].join('\n'),
  ].join('\n\n')
}

/** The homepage's comparison, as its television plays it (data.ts): a month of sending at each volume, on
 *  Nightmail and on each vendor, columns in the opening page's order. */
function homeComparison() {
  const order = MONTHS[OPENING].map(line => line.slug)
  const rows = VOLUMES.map(volume => [formatCount(volume), ...order.map(slug => usd(MONTHS[volume].find(line => line.slug === slug)!.dollars))])
  return [
    `## A month of sending, compared`,
    ASSUME,
    table(['Emails a month', ...MONTHS[OPENING].map(line => line.name)], rows, order.map((_, i) => i + 1).concat(0)),
    `Prices read on each vendor’s own pricing page: ${listOf([...new Set(RIVALS.map(rival => rival.checked))].map(day => `${listOf(RIVALS.filter(rival => rival.checked === day).map(rival => `[${rival.name}](${rival.pricing})`))} on ${day}`))}.`,
    trademarks,
  ].join('\n\n')
}

/** The questions the homepage answers (said.ts), each with its answer. */
const questions = () => [`## Questions`, ...QUESTIONS.map(item => `### ${item.question}\n\n${item.answer}`)].join('\n\n')

/** The homepage's twin, /index.md. */
export const homeMarkdown = () => factory.homeMarkdown(`${LEAD} Below, what a month of sending costs on it and on ${listOf(RIVALS.map(rival => rival.name))}.`, [agentSteps(), homeComparison(), questions()])

/** Each public page's Markdown twin (the homepage's is this one), and llms-full.txt made of them. */
export const markdownFiles = () => factory.markdownFiles().map(({ file, source }) => ({ file, source: file === 'index.md' ? homeMarkdown() : source }))
export const llmsFull = () => factory.llmsFull(markdownFiles())

/** A page's JSON-LD, with the product described by what the homepage pitches. */
export function structuredData(page: Parameters<typeof factory.structuredData>[0]): object {
  const data = factory.structuredData(page) as { '@graph': { '@id'?: string; description?: string; offers?: { description?: string } }[] }
  const app = data['@graph'].find(node => node['@id'] === url('/#app'))
  if (!app?.offers) throw new Error('The structured data has no product to describe (pricing/readable.ts, app).')
  app.description = `An email API on Amazon SES that sends and receives transactional and marketing email: ${pricePitch()}.`
  app.offers.description = `${pricePitch()}. Contacts and teammates: no charge.`
  // The homepage's own: the page, and the questions it answers (words.tsx says them on the page).
  if (page === 'home') data['@graph'].unshift(
    { '@type': 'WebPage', '@id': url('/'), url: url('/'), name: `${productName}: ${TITLE}`, description: DESCRIPTION, inLanguage: 'en', isPartOf: { '@id': url('/#website') }, about: { '@id': url('/#app') } } as object,
    { '@type': 'FAQPage', '@id': url('/#questions'), mainEntity: QUESTIONS.map(item => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })) } as object,
  )
  return data
}
