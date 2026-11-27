#!/usr/bin/env bash
set -euo pipefail
# A page of each kind (the homepage from the Worker; a price page, a comparison, a docs page, a reference page and a
# legal page from the edge's files) must not carry Cloudflare's Web Analytics script (deploy.yml says why). Retried, as
# health.sh is, for a deploy checked seconds after it lands.
origin=$1 found=()
for path in / /pricing /compare/resend /docs /docs/api/sendEmail /legal/terms; do
  html=$(curl --fail --silent --show-error --compressed --max-time 10 --retry 6 --retry-delay 5 --retry-all-errors --doh-url https://cloudflare-dns.com/dns-query "$origin$path")
  if grep -q 'cloudflareinsights' <<<"$html"; then found+=("$path"); fi
done
if (( ${#found[@]} )); then
  echo "::error title=Cloudflare Web Analytics is on::Its script is in ${found[*]}. Turn Web Analytics off for the zone (the CSP blocks the script: a console error on every page)." >&2
  exit 1
fi
echo "No Cloudflare analytics script on / /pricing /compare/resend /docs /docs/api/sendEmail /legal/terms."
