// Plain text for email from the support agent's restricted Markdown (support/PROTOCOL.md §4.2): emphasis, inline code and
// headings removed, code fences indented, links kept as their URLs. The support platform sends the agent's email answers
// through it (support/src/gate.ts), and the support inbox sends a held answer the same way (src/support-inbox.ts).
export function plainText(markdown: string) {
  return markdown
    .replace(/```[a-z]*\n([\s\S]*?)```/g, (_, code: string) => code.trimEnd().split('\n').map(line => `    ${line}`).join('\n'))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, label: string, href: string) => label === href ? href : `${label} (${href})`)
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
