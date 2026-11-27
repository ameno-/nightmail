import { BillingBanner } from './BillingBanner'
import { PolicyBanner } from './PolicyBanner'
import { SetupBanner } from './SetupBanner'
import { StandingBanner } from './StandingBanner'

// The workspace's notices (sending not set up, account standing, an empty balance), then an announced change to the legal
// pages, on every dashboard page: the shell shows them over the page, and the campaign studio, which covers the shell from
// 900 px, over its email (campaigns.css). The policy notice comes last, so it never pushes the workspace's own down.
export function Notices() {
  return <><SetupBanner /><StandingBanner /><BillingBanner /><PolicyBanner /></>
}
