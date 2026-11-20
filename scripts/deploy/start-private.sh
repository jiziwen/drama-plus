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
app_image="$image"
if [[ -f "$deploy_dir/.env" ]] && grep -Eq '^JIMENG_PRIVATE_ORIGIN=https://' "$deploy_dir/.env"; then
  app_image="${image}-app"
fi
docker build --build-arg "HUOBAO_VERSION=$release_tag" -t "$app_image" "$repo_dir"
if [[ "$app_image" != "$image" ]]; then
  docker build --build-arg "DRAMA_PLUS_BASE_IMAGE=$app_image" \
    -f "$repo_dir/docker/Dockerfile.jimeng" -t "$image" "$repo_dir"
fi
mkdir -p "$deploy_dir/data" "$deploy_dir/backups"
if [[ -f "$deploy_dir/compose.yaml" ]] && ! cmp -s "$repo_dir/deploy/tencent-private/compose.yaml" "$deploy_dir/compose.yaml"; then
  cp "$deploy_dir/compose.yaml" "$deploy_dir/compose.previous.yaml"
fi
cp "$repo_dir/deploy/tencent-private/compose.yaml" "$deploy_dir/compose.yaml"
umask 077
env_tmp=$(mktemp "$deploy_dir/.env.XXXXXX")
trap 'rm -f -- "$env_tmp"' EXIT
if [[ -f "$deploy_dir/.env" ]]; then
  install -m 600 "$deploy_dir/.env" "$deploy_dir/.env.previous"
  awk '!/^[[:space:]]*(export[[:space:]]+)?DRAMA_IMAGE[[:space:]]*=/' "$deploy_dir/.env" > "$env_tmp"
fi
printf 'DRAMA_IMAGE=%s\n' "$image" >> "$env_tmp"
mv -- "$env_tmp" "$deploy_dir/.env"
trap - EXIT
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
