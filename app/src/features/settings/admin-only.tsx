import { Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, PageHeader } from '../../components/ui'

// What a member sees where a page or section is for owners and admins: who can use it, instead of controls that fail
// with a permission error. The page stays reachable, so nothing is silently missing.
export function AdminOnly({ title }: { title: string }) {
  return <section className="admin-only" aria-label={`${title}: owners and admins only`}>
    <span className="admin-only__icon" aria-hidden="true"><Lock size={16} /></span>
    <h2>{title}: owners and admins only</h2>
  </section>
}

/** A whole page for owners and admins, as a member opens it: its title, its main action shown but disabled with the
 *  reason, and who can use it in place of the content. */
export function AdminOnlyPage({ title, button, backTo, actions }: { title: string; button?: string; backTo?: string; actions?: ReactNode }) {
  return <div className="stack">
    <PageHeader title={title} backTo={backTo} actions={(actions || button) && <>{actions}{button && <span title="Only owners and admins can do this"><Button variant="primary" disabled>{button}</Button></span>}</>} />
    <AdminOnly title={title} />
  </div>
}
