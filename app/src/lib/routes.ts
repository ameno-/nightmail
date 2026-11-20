import { matchRoutes, type RouteObject } from 'react-router'

// The dashboard's route table (App.tsx sets it once, when it loads). Analytics names a page view by its template
// (/domains/:id), never its path; a signed-out page uses it to tell a dashboard page (sign in to open it) from an
// address the dashboard doesn't have (page not found).
let routes: RouteObject[] = []
export function setRouteTable(table: RouteObject[]) { routes = table }
export function routeTemplateOf(pathname: string) {
  const matches = matchRoutes(routes, pathname)
  return matches ? '/' + matches.map(match => match.route.path ?? '').filter(Boolean).join('/').replaceAll('?', '') : '/*'
}
/** Whether a route other than the dashboard's catch-all ("Page not found") answers this path. */
export const isKnownPath = (pathname: string) => matchRoutes(routes, pathname)?.at(-1)?.route.path !== '*'
