import type { CSSProperties } from 'react'
import { NightmailWordmark } from '../../../components/NightmailLogo'
import scene from '../../home/tv/crt/scene.webp'
import still from '../../home/tv/crt/still.json'
import { plain, type PageDoc, type Table } from './shape'

// /compare drawn with the homepage's television over it (view.tsx and app/price-pages.ts, ?set): the set as the
// homepage's first screen draws it (app/home-tv.ts), the photograph with the glass open, the table's reflections and the
// room's light as still.json has them, and on the glass the page's first table in the television's type. Its
// measurements repeat tv.tsx's (SCENE, SET), which keeps them to itself.
const SCENE = { width: 2048, height: 1152 }, SET = { x: 524, y: 150, width: 1000, height: 736 }
const sceneStyle: CSSProperties = { left: `${-SET.x / SET.width * 100}%`, top: `${-SET.y / SET.height * 100}%`, width: `${SCENE.width / SET.width * 100}%`, height: `${SCENE.height / SET.height * 100}%` }

/** The set, showing the first table: its middle size's column, Nightmail's row and the next six. */
export function Television({ doc }: { doc: PageDoc }) {
  const table = doc.sections[0]?.blocks.find((block): block is Table => block.kind === 'table')
  const rows = table?.rows.slice(0, 7) ?? []
  return <div className="chy pp-stage"><div className="chy-col">
    <div className="chy-set" style={{ '--tint': still.tint, '--light': still.light } as CSSProperties}>
      <div className="chy-screen pp-glass" aria-hidden="true">
        <div className="pp-tube">
          <p className="pp-tube-head">{table ? `Per ${table.head[2]} ${table.head[0]!.split(' ')[0]}` : ''}</p>
          <ul>{rows.map((row, i) => <li key={i} data-ours={i === 0 ? '' : undefined}><span>{plain(row.cells[0]!)}</span><span>{plain(row.cells[2]!)}</span></li>)}</ul>
        </div>
      </div>
      <span className="chy-glow" />
      <img className="chy-scene" src={scene} alt="" width={SCENE.width} height={SCENE.height} draggable={false} style={sceneStyle} fetchPriority="high" />
      <img className="chy-reflect chy-reflect-shade" src={still.reflect.shade} alt="" />
      <img className="chy-reflect chy-reflect-tint" src={still.reflect.tint} alt="" />
      <a href="/" aria-label="nightmail home" className="chy-badge"><NightmailWordmark /></a>
    </div>
  </div></div>
}
