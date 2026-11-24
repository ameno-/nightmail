#!/usr/bin/env bash
# Final, credential-bearing step after dev-proof.sh --queue-only. Checkout used only the read token.
set +x
set -euo pipefail
sha=${1:?candidate SHA} healthy=${2:?last healthy production SHA}
[[ $sha =~ ^[0-9a-f]{40}$ && $healthy =~ ^[0-9a-f]{40}$ && $(git rev-parse HEAD) == "$sha" ]]
: "${GH_TOKEN:?Missing dev environment promotion token}"
url="${GITHUB_SERVER_URL:?}/${GITHUB_REPOSITORY:?}.git"
# Process-local helper only. Never put the token in a URL, argv, Git config or the runner environment file.
remote_git() { git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }
read_tips() {
  local refs
  refs=$(remote_git ls-remote --refs "$url" refs/heads/dev refs/heads/production)
  dev=$(awk '$2 == "refs/heads/dev" { print $1 }' <<< "$refs")
  prod=$(awk '$2 == "refs/heads/production" { print $1 }' <<< "$refs")
  [[ $dev =~ ^[0-9a-f]{40}$ && $prod =~ ^[0-9a-f]{40}$ ]] || { echo '::error::Missing dev or production tip.'; exit 1; }
}
superseded() {
  if [[ $dev != "$sha" ]]; then echo "Superseded by dev $dev; no promotion."; return 0; fi
  if [[ $prod == "$sha" ]]; then echo "Production already points at $sha."; return 0; fi
  if git merge-base --is-ancestor "$sha" "$prod"; then echo "Production is already ahead at $prod."; return 0; fi
  return 1
}
read_tips
if superseded; then exit 0; fi
git merge-base --is-ancestor "$healthy" "$prod" && git merge-base --is-ancestor "$prod" "$sha" || {
  echo "::error::Cannot fast-forward production $prod from its healthy base $healthy to $sha."; exit 1;
}
# The stage lock still governs the deployment started by this ordinary maintainer push.
if remote_git push "$url" "$sha:refs/heads/production"; then
  echo "Promoted production $prod → $sha (last healthy $healthy)."
else
  # A concurrent manual advance may have won. Never force or retry an uncertain write.
  read_tips
  if superseded; then exit 0; fi
  echo "::error::Fast-forward of production to $sha failed."; exit 1
fi
