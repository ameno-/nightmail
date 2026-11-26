import { skipToken, useQuery } from '@tanstack/react-query'
import { Link, Outlet, useMatch } from 'react-router'
import { Skeleton, SkeletonText, SubNav } from '../../components/ui'
import { useOnboardingStage } from '../../data/context'
import { sessionLikely } from '../../data/live'
import { ChunkFallback } from '../../lib/preloadable'
import './frame.css'
import { productName, sdkPackage } from '../../../../api/src/brand'

// The docs live at /docs, /docs/<guide> and /docs/api/<operationId>. They are public: signed in to a ready workspace
// they open inside the dashboard like any other page, and everyone else (signed out, still onboarding, search engines,
// agents) gets the same pages in a standalone layout. One component renders both (index.tsx); only the frame differs.
export type DocsAudience = 'shell' | 'standalone' | 'checking'
export function useDocsAudience(): DocsAudience | null {
  const onDocs = useMatch('/docs/*') !== null
  // Observes the session check ApiProvider runs (/v1/me) without starting another.
  const identity = useQuery({ queryKey: ['identity'], queryFn: skipToken })
  const stage = useOnboardingStage()
  if (!onDocs) return null
  if (identity.data && !identity.isError) return stage ? 'standalone' : 'shell'
  return identity.isPending && sessionLikely() ? 'checking' : 'standalone'
}

export function DocsStandalone() {
  return <div className="docs-page">
    <header className="docs-header"><Link className="docs-brand" to="/"><strong>{productName}</strong><span>Docs</span></Link><nav aria-label="Documentation links"><Link to="/docs/mcp">Connect an agent</Link><a href="/docs.md">Markdown</a><a href="/openapi.json">OpenAPI</a><a href={`https://www.npmjs.com/package/${sdkPackage}`}>TypeScript SDK</a><Link to="/overview">Dashboard</Link></nav></header>
    <ChunkFallback.Provider value={<DocsSkeleton />}><Outlet /></ChunkFallback.Provider>
  </div>
}

/** A page's place while it loads: its title and first paragraphs. */
export function DocsArticleSkeleton() {
  return <div className="docs-operation" aria-busy="true" aria-label="Loading documentation">
    <div className="docs-operation-header"><Skeleton width="38%" height={26} /><SkeletonText width="86%" /><SkeletonText width="64%" /></div>
    <div className="docs-section"><Skeleton width={120} height={18} /><SkeletonText width="92%" /><SkeletonText width="78%" /><SkeletonText width="84%" /></div>
  </div>
}

/** The docs frame while its code loads: the same columns, so nothing moves when the page arrives. */
export function DocsSkeleton() {
  return <SubNav className="docs-frame" title="Docs" titleAs="div" label="Guides and API operations" groups={[]} top={<div className="ui-control-skeleton"><Skeleton width="50%" /></div>}
    after={<div className="stack docs-nav-loading"><SkeletonText width="60%" /><SkeletonText width="80%" /><SkeletonText width="70%" /><SkeletonText width="76%" /></div>}
    picker={<div className="ui-control-skeleton"><Skeleton width="50%" /></div>}><DocsArticleSkeleton /></SubNav>
}
