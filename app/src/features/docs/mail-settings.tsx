import type { ReactNode } from 'react'
import { useSession } from '../../data/context'

/** The hosts mail apps connect to, or null when this installation has no IMAP/SMTP gateway. */
export const useMailServers = () => useSession()?.identity?.mailServers ?? null

export const imapPorts = '993 (TLS) or 143 (STARTTLS)'
export const smtpPorts = '465 (TLS) or 587 (STARTTLS)'

/** What a mail app, or an app that sends over SMTP, needs besides the secret above it. */
export function MailSettings({ username, imap = false, smtp = true }: { username: ReactNode; imap?: boolean; smtp?: boolean }) {
  const servers = useMailServers()
  if (!servers) return null
  return <dl className="keys-details" aria-label="Mail app settings">
    {imap && <div><dt>IMAP</dt><dd><code>{servers.imap}</code><br />Port {imapPorts}</dd></div>}
    {smtp && <div><dt>SMTP</dt><dd><code>{servers.smtp}</code><br />Port {smtpPorts}</dd></div>}
    <div><dt>Username</dt><dd>{username}</dd></div>
    <div><dt>Password</dt><dd>The secret above</dd></div>
  </dl>
}
