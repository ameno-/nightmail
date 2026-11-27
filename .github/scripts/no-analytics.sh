#!/usr/bin/env bash
set -euo pipefail
# No page served from the edge's files may carry Cloudflare's Web Analytics script (deploy.yml says why): a price page,
# a comparison, a docs page, a reference page and a legal page, each fetched as a browser fetches it. Cloudflare injects
# the script only into a response to a request that accepts text/html, so the request says so, with a browser's user
# agent, and asks for a compressed response, which curl decodes before the search. (Not /: the Worker answers it, and
# Cloudflare adds nothing to a Worker's response.) Retried, as health.sh is, for a deploy checked seconds after it lands.
#   no-analytics.sh https://nightmail.dev      the live pages
#   no-analytics.sh --files page.html …        saved pages (the same match, to show it finds the script)
accept='text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
carries() { grep -qE 'static\.cloudflareinsights\.com|data-cf-beacon'; }
found=()
if [[ ${1:-} == --files ]]; then
  shift
  for file in "$@"; do if carries < "$file"; then found+=("$file"); fi; done
  checked="$*"
else
  origin=$1 checked=''
  for path in /pricing /compare/resend /docs /docs/api/sendEmail /legal/terms; do
    html=$(curl --fail --silent --show-error --compressed --max-time 10 --retry 6 --retry-delay 5 --retry-all-errors --doh-url https://cloudflare-dns.com/dns-query \
      -H "Accept: $accept" -H 'Accept-Language: en-US,en;q=0.9' -A "$agent" "$origin$path")
    if carries <<<"$html"; then found+=("$path"); fi
    checked+=" $path"
  done
fi
if (( ${#found[@]} )); then
  echo "::error title=Cloudflare Web Analytics is on::Its script is in ${found[*]}. Turn Web Analytics off for the zone (the CSP blocks the script: a console error on every page)." >&2
  exit 1
fi
echo "No Cloudflare analytics script in:$checked"
