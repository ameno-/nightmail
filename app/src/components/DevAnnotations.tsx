import { Agentation } from 'agentation'

export default function DevAnnotations() {
  return <>
    {/* Lifted above the corner where the support chat docks. */}
    <style>{`[data-agentation-root], [data-agentation-root] * { font-family: var(--font-body) !important; } .nightmail-dev-annotations { bottom: calc(var(--launcher-inset) + var(--launcher-size) + var(--space-12)) !important; }`}</style>
    <Agentation endpoint="http://127.0.0.1:4747" className="nightmail-dev-annotations" />
  </>
}
