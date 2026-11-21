// Where mail apps reach the IMAP and SMTP gateway (gateway/mailgw): imap. and smtp. on MAILGW_PUBLIC_DOMAIN, on the
// gateway's ports. It imports nothing, so the support Worker checks its prompt against it.

/** The gateway's listening ports (gateway/mailgw/src/main.rs): implicit TLS, and plain with STARTTLS. */
export const MAIL_PORTS = { imap: { tls: 993, starttls: 143 }, smtp: { tls: 465, starttls: 587 } } as const;

/** The IMAP and SMTP hosts on a domain. */
export const mailServerHosts = (domain: string) => ({ imap: `imap.${domain}`, smtp: `smtp.${domain}` });
