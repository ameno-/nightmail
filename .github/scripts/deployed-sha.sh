#!/usr/bin/env bash
# Print the last healthy main Worker SHA, not a pending or failed branch tip.
set -euo pipefail
stage=${1:?stage} repo="repos/${GITHUB_REPOSITORY:?}"
[[ $stage == dev || $stage == production ]]
query="branch=$stage"
[[ $stage != production ]] || query+='&event=push'
for ((page=1; ; page++)); do
  runs=$(gh api "$repo/actions/workflows/deploy.yml/runs?$query&per_page=100&page=$page")
  [[ $(jq '.workflow_runs | length' <<< "$runs") != 0 ]] || break
  rows=$(jq -r --arg repo "$GITHUB_REPOSITORY" --arg stage "$stage" '.workflow_runs[] |
    select(.head_repository.full_name == $repo and .head_branch == $stage and
      (.event == "push" or ($stage == "dev" and .event == "workflow_dispatch"))) | [.id, .head_sha] | @tsv' <<< "$runs")
  while read -r id sha; do
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || continue
    jobs=$(gh api "$repo/actions/runs/$id/jobs?filter=latest&per_page=100")
    # A preview or support-only success cannot advance this base. A later support failure cannot undo it.
    jq -e 'any(.jobs[]; .conclusion == "success" and
      any(.steps[]; .name == "Deploy the Worker" and .conclusion == "success") and
      any(.steps[]; .name == "Health check" and .conclusion == "success"))' <<< "$jobs" >/dev/null || continue
    echo "$sha"; exit 0
  done <<< "$rows"
done
echo "No proven $stage Worker deployment found" >&2; exit 1
