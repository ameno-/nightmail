import { Fragment, useMemo, type CSSProperties, type ReactNode } from 'react'
import { blockHtmlToDocument, isBlockDocumentEmpty, type EditorNode } from './block-content'
import { cachedInlineAttachments, cidImageSources, pendingCidPlaceholder, type AttachmentKind } from './composer-content'

function parseStyle(raw: unknown): CSSProperties | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const out: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const colon = part.indexOf(':')
    if (colon <= 0) continue
    const prop = part.slice(0, colon).trim().toLowerCase()
    const val = part.slice(colon + 1).trim()
    if (!prop || !val) continue
    const camel = prop.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
    out[camel] = val
  }
  return Object.keys(out).length ? (out as CSSProperties) : undefined
}

function alignClass(attrs: Record<string, unknown> | undefined): string | undefined {
  const alignment = attrs?.alignment
  return alignment === 'left' || alignment === 'center' || alignment === 'right' ? 'align-' + alignment : undefined
}

function renderInline(nodes: EditorNode[] | undefined): ReactNode {
  if (!nodes?.length) return null
  return nodes.map((node, index) => {
    if (node.type === 'hardBreak') return <br key={index} />
    if (node.type !== 'text') return <Fragment key={index}>{renderInline(node.content)}</Fragment>
    let out: ReactNode = node.text ?? ''
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case 'bold': out = <strong>{out}</strong>; break
        case 'italic': out = <em>{out}</em>; break
        case 'underline': out = <u>{out}</u>; break
        case 'strike': out = <s>{out}</s>; break
        case 'code': out = <code>{out}</code>; break
        case 'sup': out = <sup>{out}</sup>; break
        case 'uppercase': out = <span style={{ textTransform: 'uppercase' }}>{out}</span>; break
        case 'preservedStyle': out = <span style={parseStyle(mark.attrs?.style)}>{out}</span>; break
        case 'link': {
          const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '#'
          out = <a href={href} style={parseStyle(mark.attrs?.style)} onClick={event => event.preventDefault()}>{out}</a>
          break
        }
      }
    }
    return <Fragment key={index}>{out}</Fragment>
  })
}

function renderBlock(node: EditorNode, key: number, sources: ReadonlyMap<string, string>): ReactNode {
  const style = parseStyle(node.attrs?.style)
  const align = alignClass(node.attrs)
  switch (node.type) {
    case 'paragraph': {
      const children = renderInline(node.content)
      return <p key={key} className={align} style={style}>{children ?? <br />}</p>
    }
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1))
      const children = renderInline(node.content)
      if (level === 1) return <h1 key={key} className={align} style={style}>{children}</h1>
      if (level === 2) return <h2 key={key} className={align} style={style}>{children}</h2>
      return <h3 key={key} className={align} style={style}>{children}</h3>
    }
    case 'bulletList':
      return <ul key={key} style={style}>{(node.content ?? []).map((child, i) => renderBlock(child, i, sources))}</ul>
    case 'orderedList': {
      const start = Number(node.attrs?.start)
      return <ol key={key} start={start > 1 ? start : undefined} style={style}>{(node.content ?? []).map((child, i) => renderBlock(child, i, sources))}</ol>
    }
    case 'listItem':
      return <li key={key} style={style}>{(node.content ?? []).map((child, i) => renderBlock(child, i, sources))}</li>
    case 'blockquote':
      return <blockquote key={key} style={style}>{(node.content ?? []).map((child, i) => renderBlock(child, i, sources))}</blockquote>
    case 'codeBlock':
      return <pre key={key} style={style}><code>{(node.content ?? []).map(child => child.text ?? '').join('')}</code></pre>
    case 'horizontalRule':
      return <hr key={key} style={style} />
    case 'image': {
      const rawSrc = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
      if (!rawSrc) return null
      const width = node.attrs?.width
      const height = node.attrs?.height
      const resolved = rawSrc.startsWith('cid:')
        ? (sources.get(rawSrc) ?? pendingCidPlaceholder(rawSrc.slice(4), width, height))
        : rawSrc
      const wAttr = typeof width === 'number' || (typeof width === 'string' && width !== 'auto') ? width : undefined
      const hAttr = typeof height === 'number' || (typeof height === 'string' && height !== 'auto') ? height : undefined
      const alignment = typeof node.attrs?.alignment === 'string' ? node.attrs.alignment : undefined
      const imgStyle: CSSProperties = {
        ...style,
        ...(alignment === 'center' ? { marginInline: 'auto' } : alignment === 'right' ? { marginInlineStart: 'auto', marginInlineEnd: 0 } : {}),
        ...(typeof wAttr === 'string' && wAttr.endsWith('%') ? { width: wAttr } : {}),
      }
      return <img
        key={key}
        src={resolved}
        alt={typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''}
        width={typeof wAttr === 'string' && wAttr.endsWith('%') ? undefined : wAttr as number | string | undefined}
        height={hAttr as number | string | undefined}
        style={imgStyle}
      />
    }
    case 'button': {
      const alignment = typeof node.attrs?.alignment === 'string' ? node.attrs.alignment : 'left'
      return <div key={key} className="composer-static-button-wrap" style={{ textAlign: alignment as CSSProperties['textAlign'] }}>
        <a data-button="" href={typeof node.attrs?.href === 'string' ? node.attrs.href : '#'} style={style} onClick={event => event.preventDefault()}>
          {renderInline(node.content)}
        </a>
      </div>
    }
    case 'twoColumns':
    case 'threeColumns':
    case 'fourColumns': {
      const cols = (node.content ?? []).filter(child => child.type === 'columnsColumn')
      return <div key={key} className="composer-static-columns" style={{ gridTemplateColumns: 'repeat(' + Math.max(1, cols.length) + ', minmax(0, 1fr))' }}>
        {cols.map((col, i) => <div key={i} className="composer-static-column" style={parseStyle(col.attrs?.style)}>
          {(col.content ?? []).map((child, j) => renderBlock(child, j, sources))}
        </div>)}
      </div>
    }
    case 'section':
      return <section key={key} className="composer-static-section" style={style}>
        {(node.content ?? []).map((child, i) => renderBlock(child, i, sources))}
      </section>
    default:
      if (!node.content?.length) return null
      return <Fragment key={key}>{(node.content ?? []).map((child, i) => renderBlock(child, i, sources))}</Fragment>
  }
}

/** Lightweight, XSS-safe static render of block HTML with exact .tiptap typography and spacing.
 *  Paints on frame 1 while the composer chunk or ProseMirror initializes, then swaps cleanly to the live editor. */
export function StaticEmailBody({
  html,
  attachmentIds = [],
  kind = 'campaigns',
  resolvedSources,
  placeholder = 'Write, or type / for blocks…',
  onInteract,
}: {
  html: string
  attachmentIds?: readonly string[]
  kind?: AttachmentKind
  resolvedSources?: ReadonlyMap<string, string>
  placeholder?: string
  onInteract?: () => void
}) {
  const doc = useMemo(() => blockHtmlToDocument(html), [html])
  const empty = useMemo(() => isBlockDocumentEmpty(doc), [doc])
  const sources = useMemo(() => {
    const merged = new Map<string, string>()
    const needed = cidImageSources(html)
    if (needed.size) {
      const cached = cachedInlineAttachments(kind, attachmentIds, needed)
      cached.sources.forEach((url, cid) => merged.set(cid, url))
    }
    resolvedSources?.forEach((url, cid) => merged.set(cid, url))
    return merged
  }, [html, attachmentIds, kind, resolvedSources])

  return <div className="composer-static-doc" onMouseDown={onInteract}>
    {empty
      ? <p className="composer-static-placeholder">{placeholder}</p>
      : (doc.content ?? []).map((node, index) => renderBlock(node, index, sources))}
  </div>
}
