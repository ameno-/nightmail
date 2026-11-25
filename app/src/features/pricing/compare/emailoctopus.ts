import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs EmailOctopus (/compare/emailoctopus): a comparison's whole entry (prices.ts, Entry). Every figure was read
// on EmailOctopus's own pages on CHECKED: the monthly prices in pricing.md, which carries its pricing page's tables.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const EMAILOCTOPUS = 'https://emailoctopus.com/pricing'
const MD = 'https://emailoctopus.com/pricing.md'
const tier = (size: number, cents: number, sends: number, quote: string): Tier => ({ size, cents, sends, source: read(MD, quote) })
// Its standard plans only: each tier's price includes a monthly email allowance. EmailOctopus Connect is left out: it
// sends through your own Amazon SES account, so its price leaves out what AWS bills for the sending and isn't a whole
// monthly price.
const offer: Offer = {
  id: 'emailoctopus', vendor: 'EmailOctopus', name: 'EmailOctopus', pricing: EMAILOCTOPUS, checked: CHECKED, unit: 'contacts', ladder: 'complete',
  counts: 'subscribers and emails sent',
  beyond: { text: 'A custom plan', source: read(MD, 'For more than 500,000 subscribers, contact us for a custom plan.') },
  plans: [
    { name: 'Starter', max: { size: 2_500, source: read(EMAILOCTOPUS, 'STARTER Free 2,500 subscribers 10,000 emails per month EmailOctopus branding on emails Reports available for 30 days Create 1 landing page and 1 form Access for 1 user') }, tiers: [
      tier(2_500, 0, 10_000, 'Up to 2,500 subscribers - 10,000 emails per month - No credit card needed and no time limit'),
    ] },
    { name: 'Pro', tiers: [
      tier(500, 1_000, 10_000, '| Up to 500 | 10,000 | $10 | $108 | $9 | $75.60 |'),
      tier(1_000, 1_350, 10_000, '| 501 to 1,000 | 10,000 | $13.50 | $144 | $12 | $100.80 |'),
      tier(2_500, 2_000, 25_000, '| 1,001 to 2,500 | 25,000 | $20 | $216 | $18 | $151.20 |'),
      tier(5_000, 3_150, 50_000, '| 2,501 to 5,000 | 50,000 | $31.50 | $336 | $28 | $235.20 |'),
      tier(7_500, 3_800, 75_000, '| 5,001 to 7,500 | 75,000 | $38 | $408 | $34 | $285.60 |'),
      tier(10_000, 4_450, 100_000, '| 7,501 to 10,000 | 100,000 | $44.50 | $480 | $40 | $336 |'),
      tier(15_000, 6_000, 150_000, '| 10,001 to 15,000 | 150,000 | $60 | $648 | $54 | $453.60 |'),
      tier(20_000, 7_800, 200_000, '| 15,001 to 20,000 | 200,000 | $78 | $840 | $70 | $588 |'),
      tier(25_000, 9_450, 250_000, '| 20,001 to 25,000 | 250,000 | $94.50 | $1,020 | $85 | $714 |'),
      tier(30_000, 11_200, 300_000, '| 25,001 to 30,000 | 300,000 | $112 | $1,200 | $100 | $840 |'),
      tier(35_000, 12_800, 350_000, '| 30,001 to 35,000 | 350,000 | $128 | $1,380 | $115 | $966 |'),
      tier(40_000, 14_500, 400_000, '| 35,001 to 40,000 | 400,000 | $145 | $1,560 | $130 | $1,092 |'),
      tier(45_000, 16_200, 450_000, '| 40,001 to 45,000 | 450,000 | $162 | $1,740 | $145 | $1,218 |'),
      tier(50_000, 17_800, 500_000, '| 45,001 to 50,000 | 500,000 | $178 | $1,920 | $160 | $1,344 |'),
      tier(55_000, 19_500, 550_000, '| 50,001 to 55,000 | 550,000 | $195 | $2,100 | $175 | $1,470 |'),
      tier(60_000, 21_200, 600_000, '| 55,001 to 60,000 | 600,000 | $212 | $2,280 | $190 | $1,596 |'),
      tier(65_000, 22_800, 650_000, '| 60,001 to 65,000 | 650,000 | $228 | $2,460 | $205 | $1,722 |'),
      tier(70_000, 24_500, 700_000, '| 65,001 to 70,000 | 700,000 | $245 | $2,640 | $220 | $1,848 |'),
      tier(75_000, 26_200, 750_000, '| 70,001 to 75,000 | 750,000 | $262 | $2,820 | $235 | $1,974 |'),
      tier(80_000, 27_800, 800_000, '| 75,001 to 80,000 | 800,000 | $278 | $3,000 | $250 | $2,100 |'),
      tier(85_000, 29_500, 850_000, '| 80,001 to 85,000 | 850,000 | $295 | $3,180 | $265 | $2,226 |'),
      tier(90_000, 31_200, 900_000, '| 85,001 to 90,000 | 900,000 | $312 | $3,360 | $280 | $2,352 |'),
      tier(95_000, 32_800, 950_000, '| 90,001 to 95,000 | 950,000 | $328 | $3,540 | $295 | $2,478 |'),
      tier(100_000, 34_500, 1_000_000, '| 95,001 to 100,000 | 1,000,000 | $345 | $3,720 | $310 | $2,604 |'),
      tier(120_000, 40_000, 1_200_000, '| 100,001 to 120,000 | 1,200,000 | $400 | $4,320 | $360 | $3,024 |'),
      tier(140_000, 45_600, 1_400_000, '| 120,001 to 140,000 | 1,400,000 | $456 | $4,920 | $410 | $3,444 |'),
      tier(160_000, 51_200, 1_600_000, '| 140,001 to 160,000 | 1,600,000 | $512 | $5,520 | $460 | $3,864 |'),
      tier(180_000, 56_700, 1_800_000, '| 160,001 to 180,000 | 1,800,000 | $567 | $6,120 | $510 | $4,284 |'),
      tier(200_000, 62_300, 2_000_000, '| 180,001 to 200,000 | 2,000,000 | $623 | $6,720 | $560 | $4,704 |'),
      tier(220_000, 68_900, 2_200_000, '| 200,001 to 220,000 | 2,200,000 | $689 | $7,440 | $620 | $5,208 |'),
      tier(240_000, 74_500, 2_400_000, '| 220,001 to 240,000 | 2,400,000 | $745 | $8,040 | $670 | $5,628 |'),
      tier(260_000, 80_000, 2_600_000, '| 240,001 to 260,000 | 2,600,000 | $800 | $8,640 | $720 | $6,048 |'),
      tier(280_000, 85_600, 2_800_000, '| 260,001 to 280,000 | 2,800,000 | $856 | $9,240 | $770 | $6,468 |'),
      tier(300_000, 91_200, 3_000_000, '| 280,001 to 300,000 | 3,000,000 | $912 | $9,840 | $820 | $6,888 |'),
      tier(320_000, 96_700, 3_200_000, '| 300,001 to 320,000 | 3,200,000 | $967 | $10,440 | $870 | $7,308 |'),
      tier(340_000, 102_300, 3_400_000, '| 320,001 to 340,000 | 3,400,000 | $1,023 | $11,040 | $920 | $7,728 |'),
      tier(360_000, 107_800, 3_600_000, '| 340,001 to 360,000 | 3,600,000 | $1,078 | $11,640 | $970 | $8,148 |'),
      tier(380_000, 113_400, 3_800_000, '| 360,001 to 380,000 | 3,800,000 | $1,134 | $12,240 | $1,020 | $8,568 |'),
      tier(400_000, 118_900, 4_000_000, '| 380,001 to 400,000 | 4,000,000 | $1,189 | $12,840 | $1,070 | $8,988 |'),
      tier(420_000, 125_600, 4_200_000, '| 400,001 to 420,000 | 4,200,000 | $1,256 | $13,560 | $1,130 | $9,492 |'),
      tier(440_000, 131_200, 4_400_000, '| 420,001 to 440,000 | 4,400,000 | $1,312 | $14,160 | $1,180 | $9,912 |'),
      tier(460_000, 136_700, 4_600_000, '| 440,001 to 460,000 | 4,600,000 | $1,367 | $14,760 | $1,230 | $10,332 |'),
      tier(480_000, 142_300, 4_800_000, '| 460,001 to 480,000 | 4,800,000 | $1,423 | $15,360 | $1,280 | $10,752 |'),
      tier(500_000, 147_800, 5_000_000, '| 480,001 to 500,000 | 5,000,000 | $1,478 | $15,960 | $1,330 | $11,172 |'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [5_000, 10_000, 100_000]
export const emailOctopus: Entry = {
  slug: 'emailoctopus',
  vendor: 'EmailOctopus',
  focus: 'newsletter',
  offer,
  model: { per: 'contact', sendsPerContact: 4, seats: 1 },
  sizes,
  // EmailOctopus's free Starter plan holds 2,500 subscribers (10,000 emails), so the fader starts at its next list size
  // and runs through every one it prices, to 500,000.
  steps: tierSizes(offer, 5_000, 500_000),
  lead: 'EmailOctopus prices by subscribers. Nightmail prices by email.',
  assume: 'Four emails a month to each subscriber, 1 teammate, EmailOctopus’s cheapest plan that holds them. List prices before tax.',
  rows: [
    fact('No email allowance to outgrow', `Every email is ${nightmail.perThousand} per 1,000, with no tiers.`, 'Each EmailOctopus tier includes a monthly email allowance; past it you need a larger tier.', read(MD, 'Each price includes a monthly email allowance. If you send more emails than a tier allows, you need a larger tier.')),
    fact('Teammates at no charge', 'No charge for teammates.', 'EmailOctopus’s free Starter plan gives access to 1 user.', read(EMAILOCTOPUS, 'Access for 1 user … Add unlimited users')),
  ],
  // A newsletter's readers first see the list, the contacts and what keeps it clean.
  panels: ['campaign', 'contacts', 'hygiene', 'ready', 'team', 'domain', 'receive'],
  without: ['signup forms', 'landing pages', 'automations'],
  description: `EmailOctopus prices by subscribers, Nightmail by email. Monthly prices at ${listOf(sizes.map(formatCount))} subscribers, checked ${dayOf(CHECKED)}.`,
}
