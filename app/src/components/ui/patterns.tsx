import type { ReactNode, Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { CopyButton, PageHeader, type Tone } from './primitives';
import { Icon } from './icon';

// The dashboard's two page patterns, built from the primitives. Styles: "Page patterns" in styles/ui.css.
const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ');

/** A list page, top to bottom: its header (PageHeader), optional tabs, one toolbar row (ListToolbar), the table or list
 *  (children) and its pagination. It fills the page's column, so the pagination sits at the bottom. */
export function ListPage({ header, tabs, toolbar, pagination, children, className }: { header: ReactNode; tabs?: ReactNode; toolbar?: ReactNode; pagination?: ReactNode; children: ReactNode; className?: string }) {
  return <div data-component="ListPage" className={cx('ui-list-page', className)}>{header}{tabs}{toolbar}{children}{pagination}</div>;
}

/** A list's one row of controls: the search fills the free width, then the filters (selects), then trailing utilities
 *  (`end`: an export or settings icon button). On a phone the search takes its own row. */
export function ListToolbar({ search, filters, end, className }: { search?: ReactNode; filters?: ReactNode; end?: ReactNode; className?: string }) {
  return <div data-component="ListToolbar" className={cx('ui-list-toolbar', className)}>
    {search && <div className="ui-list-toolbar__search">{search}</div>}
    {filters && <div className="ui-list-toolbar__filters">{filters}</div>}
    {end && <div className="ui-list-toolbar__end">{end}</div>}
  </div>;
}

/** A detail page's header: the kind of thing it is (`typeLabel`, sentence case: "Sent email") over its title, the back
 *  button, and its actions level with the title. `icon`: a quiet flat square before the title, neutral or in `tone`. */
export function DetailHeader({ typeLabel, title, backTo, actions, subtitle, icon, tone = 'neutral', className }: { typeLabel: ReactNode; title: ReactNode; backTo?: string; actions?: ReactNode; subtitle?: ReactNode; icon?: LucideIcon; tone?: Tone; className?: string }) {
  return <PageHeader className={cx('ui-detail-header', className)} eyebrow={typeLabel} title={title} backTo={backTo} actions={actions} subtitle={subtitle}
    leading={icon && <span className={cx('ui-detail-header__icon', `ui-tone--${tone}`)} aria-hidden="true"><Icon icon={icon} size="lg" /></span>} />;
}

/** One fact of a detail page: a muted label over its value; `mono` for IDs, DNS, endpoints and timestamps. */
export type Fact = { key?: string; label: ReactNode; value: ReactNode; mono?: boolean; title?: string };
/** The facts under a detail header, in one row on a desktop (two columns on a phone), each value on one line. */
export function FactsRow({ items, label, className }: { items: Fact[]; label?: string; className?: string }) {
  return <dl data-component="FactsRow" className={cx('ui-facts-row', className)} aria-label={label}>{items.map((item, index) => <div key={item.key ?? (typeof item.label === 'string' ? item.label : index)} className="ui-facts-row__item">
    <dt>{item.label}</dt><dd className={item.mono ? 'ui-facts-row__mono' : undefined} title={item.title}>{item.value}</dd>
  </div>)}</dl>;
}

/** An ID or key, mono and cut in the middle (its first `head` and last `tail` characters stay), with a copy button that
 *  shows on hover and focus (always on a touch screen). The whole value is in its title and read to a screen reader. */
export function Identifier({ value, head = 10, tail = 8, copyLabel = 'Copy ID', className }: { value: string; head?: number; tail?: number; copyLabel?: string; className?: string }) {
  const cut = value.length > head + tail + 1;
  return <span data-component="Identifier" className={cx('ui-identifier', className)}>
    <code className="ui-identifier__value" title={cut ? value : undefined}>{cut ? <><span aria-hidden="true">{value.slice(0, head)}…{value.slice(-tail)}</span><span className="sr-only">{value}</span></> : value}</code>
    <CopyButton value={value} label={copyLabel} />
  </span>;
}

/** A row of a page's own contents (SubNav): where it goes, what it says, and whether it is the page shown. `text` is its
 *  label in the phone's picker when `label` isn't plain text; `lead` and `trail` sit before and after it (an API
 *  method, a lock). */
export type SubNavItem = { to: string; label: ReactNode; text?: string; current?: boolean; lead?: ReactNode; trail?: ReactNode; title?: string };
export type SubNavGroup = { title: string; items: SubNavItem[] };
/**
 * A page with its own contents beside it (Settings, Docs): the page's title over a column of labelled groups of rows,
 * in the main sidebar's type, rhythm and selected state, then the page. Where two columns don't fit (a phone, a tablet,
 * a narrow window: a container query, so the main sidebar counts) the column becomes a picker under the title.
 * `top` sits over the groups (a search field); `after` under them (a loading state, "Nothing matches"); the picker lists
 * `pickerGroups` (default: the groups) and, when no row is the page shown, `fallback` as its value. `titleAs`: h1 when
 * the title is the page's (Settings), a plain label when the page has its own (Docs).
 */
export function SubNav({ title, titleAs = 'h1', label, groups, top, after, pickerGroups = groups, fallback, picker, replace = false, scrollRef, main = 'div', children, className }: {
  title: ReactNode; titleAs?: 'h1' | 'div'; label: string; groups: SubNavGroup[]; top?: ReactNode; after?: ReactNode; pickerGroups?: SubNavGroup[]; fallback?: string; picker?: ReactNode;
  replace?: boolean; scrollRef?: Ref<HTMLDivElement>; main?: 'div' | 'main'; children: ReactNode; className?: string;
}) {
  const navigate = useNavigate();
  const Title = titleAs, Main = main;
  const current = pickerGroups.flatMap(group => group.items).find(item => item.current);
  const text = (item: SubNavItem) => item.text ?? (typeof item.label === 'string' ? item.label : item.to);
  return <div data-component="SubNav" className={cx('ui-subnav-frame', className)}><div className="ui-subnav-layout">
    <Title className="ui-subnav__title">{title}</Title>
    <div className="ui-subnav">
      {top && <div className="ui-subnav__top">{top}</div>}
      <div className="ui-subnav__scroll" ref={scrollRef}><nav aria-label={label}>
        {groups.map(group => <div key={group.title} className="ui-subnav__group"><h2 className="ui-subnav__label">{group.title}</h2>
          {group.items.map(item => <Link key={item.to} to={item.to} replace={replace} aria-current={item.current ? 'page' : undefined} title={item.title}>{item.lead}<span className="ui-subnav__text">{item.label}</span>{item.trail}</Link>)}
        </div>)}
        {after}
      </nav></div>
    </div>
    <div className="ui-subnav__picker">{picker ?? <select className="ui-input ui-select-trigger ui-native-select" aria-label={label} value={current?.to ?? ''} onChange={event => navigate(event.target.value, { replace })}>
      {!current && <option value="" disabled>{fallback ?? ''}</option>}
      {pickerGroups.map(group => <optgroup key={group.title} label={group.title}>{group.items.map(item => <option key={item.to} value={item.to}>{text(item)}</option>)}</optgroup>)}
    </select>}</div>
    <Main className="ui-subnav-main">{children}</Main>
  </div></div>;
}
