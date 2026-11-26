// What an email preview shows in place of an image it doesn't load. Shared by the email as sent (components/EmailPreview.tsx)
// and the emulated clients' frames (components/EmailFrame.tsx), whose images the API drops.

/** A size attribute or inline style value in pixels ("120", "120px"), else null. */
export const px = (value: string | null | undefined) => { const match = value?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i); return match ? Number(match[1]) : null; };
const xml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
/**
 * What the preview shows in place of an image it doesn't load (a remote one held back, one it can't load, an inline one
 * still on its way): a quiet tile at the image's declared size (its width and height attributes, else its inline style;
 * a guess from the other side or its alt text where one is missing) with its alt text, so the email keeps its layout and
 * reads as an image not loaded, never as the browser's broken-image icon. Only the preview's copy changes.
 */
export function heldImageSource(image: Element) {
  const style = (image.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '')
  const styled = (name: string) => px(style.match(new RegExp(`(?:^|;)${name}:([\\d.]+(?:px)?)(?:;|$)`))?.[1])
  const alt = (image.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim()
  // A declared 0 (a tracking pixel an emulation kept) stays 0: nothing to show.
  const declared = (value: number | null) => value !== null ? Math.min(Math.round(value), 2400) : null
  let width = declared(px(image.getAttribute('width')) ?? styled('width')), height = declared(px(image.getAttribute('height')) ?? styled('height'))
  width ??= height ? Math.min(height * 3, 600) : Math.min(600, Math.max(64, Math.round(alt.length * 6.5) + 24))
  height ??= Math.max(24, Math.min(240, Math.round(width / 3)))
  const room = Math.floor((width - 16) / 6.5), label = height >= 16 && room >= 3 ? (alt.length > room ? `${alt.slice(0, room - 1).trimEnd()}…` : alt) : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="${Math.min(4, width / 4, height / 4)}" fill="#808080" fill-opacity=".14"/>${label ? `<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif" font-size="12" fill="#808080">${xml(label)}</text>` : ''}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
