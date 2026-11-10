#!/usr/bin/env bash
# Run on the server after extracting a source archive.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release_tag="${1:?Usage: bash scripts/deploy/start-private.sh RELEASE_TAG}"
if [[ ! "$release_tag" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo 'Invalid release tag' >&2
  exit 1
fi
deploy_dir="${DRAMA_DEPLOY_DIR:-/opt/drama-plus}"
image="drama-plus:$release_tag"
docker compose version >/dev/null
docker build --build-arg "HUOBAO_VERSION=$release_tag" -t "$image" "$repo_dir"
mkdir -p "$deploy_dir/data" "$deploy_dir/backups"
if [[ -f "$deploy_dir/compose.yaml" ]] && ! cmp -s "$repo_dir/deploy/tencent-private/compose.yaml" "$deploy_dir/compose.yaml"; then
  cp "$deploy_dir/compose.yaml" "$deploy_dir/compose.previous.yaml"
fi
cp "$repo_dir/deploy/tencent-private/compose.yaml" "$deploy_dir/compose.yaml"
if [[ -f "$deploy_dir/.env" ]]; then
  cp "$deploy_dir/.env" "$deploy_dir/.env.previous"
fi
umask 077
printf 'DRAMA_IMAGE=%s\n' "$image" > "$deploy_dir/.env"
cd "$deploy_dir"
docker compose config --quiet
docker compose up -d
for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:5679/api/v1/health; then
    printf '\nPrivate application is healthy. Port 5679 listens on localhost only.\n'
    exit 0
  fi
  sleep 2
done
docker compose ps
echo 'Health check did not pass within 120 seconds. Inspect docker compose logs.' >&2
exit 1
