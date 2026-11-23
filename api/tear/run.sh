#!/usr/bin/env bash
# On-demand runner for Nightmail's reworked TypeScript tear models.
#
# Usage (from api/ or via `bun run tear:ci`):
#   bash tear/run.sh                      # all 6 core checkers (campaigns + 20 guided seeds each)
#   bash tear/run.sh all                  # all 6 core + 5 preventative safety models
#   bash tear/run.sh safety               # the 5 preventative safety models
#   bash tear/run.sh dispatch access      # named checkers only
#
# Environment:
#   TEAR_DATABASE_URL  Reuse an existing migrated, disposable-marked Postgres DB (single checker or shared).
#                      When unset, starts a throwaway postgres:17.11-alpine container in Docker and removes it on exit.
#   TEAR_SEEDS         Guided seed range per checker (default: 1..20; set to "" for campaigns only).
#   TEAR_PG_PORT       Localhost port for the throwaway Docker Postgres (default: 55488).
#   TEAR_DIR           Optional local tear checkout passed to setup.sh if @tear/mbt is not yet installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$(cd "$HERE/.." && pwd)"

if [[ ! -d "$HERE/node_modules/@tear/mbt/src" ]] || ! command -v tear >/dev/null 2>&1; then
  bash "$HERE/setup.sh"
fi

CORE=(dispatch ses access admission inbox delivery)
SAFETY=(campaign-collab campaign-attachments db-faults scale-reads tenant-isolation)

SELECTED=()
if (( $# == 0 )); then
  SELECTED=("${CORE[@]}")
else
  for arg in "$@"; do
    case "$arg" in
      core) SELECTED+=("${CORE[@]}") ;;
      safety) SELECTED+=("${SAFETY[@]}") ;;
      all) SELECTED+=("${CORE[@]}" "${SAFETY[@]}") ;;
      dispatch|ses|access|admission|inbox|delivery|campaign-collab|campaign-attachments|db-faults|scale-reads|tenant-isolation)
        SELECTED+=("$arg") ;;
      *) echo "unknown checker: $arg" >&2; exit 2 ;;
    esac
  done
fi

SEEDS="${TEAR_SEEDS-1..20}"
CONTAINER=""
PORT="${TEAR_PG_PORT:-55488}"
SECRET="$(openssl rand -hex 36)"

cleanup() {
  if [[ -n "$CONTAINER" ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${TEAR_DATABASE_URL:-}" ]]; then
  CONTAINER="nightmail-tear-$$"
  docker run -d --name "$CONTAINER"     -e POSTGRES_PASSWORD=tear     -p "127.0.0.1:$PORT:5432"     postgres:17.11-alpine     -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
  for _ in $(seq 1 80); do
    PGPASSWORD=tear psql -h 127.0.0.1 -p "$PORT" -U postgres -c 'SELECT 1' >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

prep_db() {
  local name="$1"
  if [[ -n "${TEAR_DATABASE_URL:-}" ]]; then
    echo "$TEAR_DATABASE_URL"
    return
  fi
  local db="tear_${name//-/_}"
  local url="postgresql://postgres:tear@127.0.0.1:$PORT/$db"
  PGPASSWORD=tear psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q     -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" >/dev/null
  (cd "$API_DIR" && DATABASE_URL="$url" BANE_ROOT_SECRET="$SECRET" PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts >/dev/null)
  PGPASSWORD=tear psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -q     -c "COMMENT ON DATABASE $db IS 'bane-tear: disposable test database, every row may be changed or deleted'" >/dev/null
  echo "$url"
}

run_one() {
  local name="$1" model_file="" campaign_file="" extra=()
  case "$name" in
    dispatch|ses|access|admission|inbox|delivery)
      model_file="$name/$name.model.ts"
      campaign_file="$name/campaigns/$name.json"
      ;;
    campaign-collab|tenant-isolation)
      model_file="safety/$name.model.ts"
      campaign_file="safety/campaigns/$name.json"
      extra=(--rounds 2)
      ;;
    campaign-attachments|db-faults|scale-reads)
      model_file="safety/$name.model.ts"
      campaign_file="safety/campaigns/$name.json"
      ;;
  esac

  local db_url
  db_url="$(prep_db "$name")"
  local seed_args=()
  if [[ -n "$SEEDS" ]]; then
    if [[ "$name" == "scale-reads" ]]; then
      seed_args=(--seeds 1..5)
    else
      seed_args=(--seeds "$SEEDS")
    fi
  fi

  echo "=== tear: $name ==="
  (cd "$HERE" && TEAR_DATABASE_URL="$db_url" tear test "$model_file" "$name" --campaign "$campaign_file" --no-shrink ${seed_args[@]+"${seed_args[@]}"} ${extra[@]+"${extra[@]}"})
}

for checker in "${SELECTED[@]}"; do
  run_one "$checker"
done
