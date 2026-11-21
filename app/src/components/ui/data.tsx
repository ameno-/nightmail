import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from './primitives';

// Data display (Signal Log): flat, hairline-drawn pieces for dense pages. Labels are small and muted, values mono with
// tabular figures, and colour only says how something went (a tone's dot, ink or bar). Every piece has a fixed height in
// every state, so a loading page and a loaded one hold the same space.
const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ');
const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** A value against its limit: a 2px track, the share filled in the tone's colour, and a tick where the limit (or a warning line) sits. */
export function Meter({ value, max = 1, mark, tone = 'neutral', label, className }: { value: number; max?: number; mark?: number; tone?: Tone; label?: string; className?: string }) {
  const share = clamp(value / max), at = mark === undefined ? undefined : clamp(mark / max);
  return <span className={cx('ui-meter', `ui-tone--${tone}`, className)} role={label ? 'meter' : undefined} aria-label={label} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? max : undefined} aria-valuenow={label ? value : undefined} aria-hidden={label ? undefined : true}
    style={{ '--share': `${share * 100}%`, ...at !== undefined && { '--mark': `${at * 100}%` } } as CSSProperties}><i />{at !== undefined && <b />}</span>;
}

/** One metric as a row: label (and a muted hint), its series, the mono value with a muted unit; a meter is the row's rule. */
export function MetricRow({ label, hint, spark, value, unit, tone, meter, className }: { label: ReactNode; hint?: ReactNode; spark?: ReactNode; value: ReactNode; unit?: ReactNode; tone?: Tone; meter?: ReactNode; className?: string }) {
  return <div className={cx('ui-metric', meter ? 'ui-metric--meter' : null, className)} data-tone={tone}>
    <span className="ui-metric__label"><span>{label}</span>{hint !== undefined && <span className="ui-metric__hint">{hint}</span>}</span>
    <span className="ui-metric__spark">{spark}</span>
    {/* Laid out from the cell's right edge and pulled back by its own width: a figure that tweens through wider and
        narrower numbers never moves its box (a transform, not a layout shift). */}
    <span className={cx('ui-metric__value', tone && tone !== 'neutral' && `ui-tone--${tone}`)}><span className="ui-metric__figure">{value}{unit && <span className="ui-metric__unit">{unit}</span>}</span></span>
    {meter}
  </div>;
}

/** A facet: a value, its tone's dot and its count. Selectable when it has onSelect; `slot` reserves an empty row. */
/** `series`: the data palette's hue for the value (sent, received, delivered, opened, clicked, bounced, complained); else its tone's. */
export type Facet = { key: string; label?: ReactNode; count?: number | null; tone?: Tone; series?: string; selected?: boolean; onSelect?: () => void; slot?: boolean };
export type FacetGroup = { key: string; title: ReactNode; items: Facet[] };
/** The facets beside a list: each group a small caps title over its values, each value with its count. */
export function FacetRail({ groups, label = 'Facets' }: { groups: FacetGroup[]; label?: string }) {
  return <nav className="ui-facets" aria-label={label}>
    {groups.map(group => <section key={group.key} className="ui-facets__group" aria-label={typeof group.title === 'string' ? group.title : undefined}>
      <h3 className="ui-facets__title">{group.title}</h3>
      <ul>{group.items.map(item => {
        if (item.slot) return <li key={item.key} className="ui-facet ui-facet--slot" aria-hidden="true" />;
        const body = <><span className={cx('ui-facet__dot', `ui-tone--${item.tone ?? 'neutral'}`, item.series && `ui-series--${item.series}`)} aria-hidden="true" /><span className="ui-facet__label">{item.label}</span><span className="ui-facet__count">{item.count === null || item.count === undefined ? '–' : item.count.toLocaleString()}</span></>;
        return <li key={item.key}>{item.onSelect ? <button type="button" className="ui-facet" aria-pressed={item.selected ?? false} data-empty={!item.count || undefined} onClick={item.onSelect}>{body}</button> : <span className="ui-facet" data-empty={!item.count || undefined}>{body}</span>}</li>;
      })}</ul>
    </section>)}
  </nav>;
}

/** A list beside its rail (facets, a thread): a hairline between them. `collapse`: below 1200 px the rail hides, or becomes a row over the list. */
export function SplitPane({ rail, children, collapse = 'hide', className }: { rail: ReactNode; children: ReactNode; collapse?: 'hide' | 'row'; className?: string }) {
  return <div className={cx('ui-split', className)} data-collapse={collapse}><div className="ui-split__rail">{rail}</div><div className="ui-split__main">{children}</div></div>;
}

/** Counts over time as thin bars on a hairline with mono edge labels, stacked by series (the data palette's hues), the first at the bottom. */
export type HistogramBin = Record<string, number>;
export function Histogram({ bins, series, start, end, label, className }: { bins: HistogramBin[]; series: string[]; start?: ReactNode; end?: ReactNode; label: string; className?: string }) {
  const sum = (bin: HistogramBin) => series.reduce((total, key) => total + (bin[key] ?? 0), 0);
  const max = Math.max(1, ...bins.map(sum));
  return <div className={cx('ui-histogram', className)} role="img" aria-label={label}>
    <div className="ui-histogram__bars">{bins.map((bin, i) => { const total = sum(bin); return <span key={i} className="ui-histogram__bin" data-zero={!total || undefined} style={{ '--h': `${total / max * 100}%` } as CSSProperties}>
      {[...series].reverse().map(key => (bin[key] ?? 0) > 0 && <i key={key} className={`ui-series--${key}`} style={{ flexGrow: bin[key] }} />)}
    </span> })}</div>
    <div className="ui-histogram__axis" aria-hidden="true"><span>{start}</span><span>{end}</span></div>
  </div>;
}

/** Events on one time axis, oldest first: a row each with its dot, name, a bar from when it happened to the next one, and the time since the first. */
export type WaterfallRow = { key: string; label: ReactNode; tone: Tone; series?: string; at: number; delta: ReactNode };
// Mail moves in milliseconds, then waits minutes for an open: a log scale keeps both readable on one axis.
const scale = (ms: number, span: number) => span <= 0 ? 0 : Math.log1p(Math.max(0, ms)) / Math.log1p(span);
export function Waterfall({ rows, label, className }: { rows: WaterfallRow[]; label: string; className?: string }) {
  const first = rows[0]?.at ?? 0, span = Math.max(0, ...rows.map(row => row.at - first));
  return <ol className={cx('ui-waterfall', className)} aria-label={label}>{rows.map((row, i) => {
    const from = scale(row.at - first, span), next = rows[i + 1], to = next ? scale(next.at - first, span) : from;
    return <li key={row.key} className={cx('ui-waterfall__row', `ui-tone--${row.tone}`, row.series && `ui-series--${row.series}`)}>
      <span className="ui-waterfall__dot" aria-hidden="true" /><span className="ui-waterfall__label">{row.label}</span>
      <span className="ui-waterfall__track" aria-hidden="true"><i style={{ left: `${from * 100}%`, width: next ? `max(2px, ${(to - from) * 100}%)` : '2px' }} /></span>
      <span className="ui-waterfall__delta">{row.delta}</span>
    </li>;
  })}</ol>;
}
/** Elapsed time, compact: 400ms, 2.1s, 4m 12s, 3h 5m, 2d 4h. */
export function elapsed(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m ${Math.round(ms / 1000) % 60}s`;
}

/** Facts as muted keys and mono values. */
export function KeyValues({ items, className }: { items: [key: ReactNode, value: ReactNode][]; className?: string }) {
  return <dl className={cx('ui-kv', className)}>{items.map(([key, value], i) => <div key={i}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}
