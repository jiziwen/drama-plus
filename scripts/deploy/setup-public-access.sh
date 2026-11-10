#!/usr/bin/env bash
# The owner runs this interactively; passwords are never command-line arguments.
# This creates configuration only. Starting the public gateway is a separate step.
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then
  echo 'Run this script with sudo.' >&2
  exit 1
fi
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_dir="/opt/drama-plus-public"
if [[ -e "$deploy_dir/access.caddy" ]]; then
  echo 'An access password already exists; refusing to overwrite it.' >&2
  exit 1
fi
read -r -s -p 'Set website access password (at least 16 characters): ' access_password < /dev/tty
printf '\n'
read -r -s -p 'Repeat website access password: ' password_confirmation < /dev/tty
printf '\n'
if [[ ${#access_password} -lt 16 || "$access_password" != "$password_confirmation" ]]; then
  echo 'Passwords differ or are shorter than 16 characters.' >&2
  exit 1
fi
password_hash="$(printf '%s' "$access_password" | docker run --rm -i --network none caddy:2.11.9-alpine caddy hash-password)"
unset access_password password_confirmation
if [[ "$password_hash" != '$2'* ]]; then
  echo 'Password hashing did not produce a bcrypt hash.' >&2
  exit 1
fi
umask 077
mkdir -p "$deploy_dir"
cp "$repo_dir/deploy/tencent-public/compose.yaml" "$deploy_dir/compose.yaml"
cp "$repo_dir/deploy/tencent-public/Caddyfile" "$deploy_dir/Caddyfile"
printf 'basic_auth {\n    admin %s\n}\n' "$password_hash" > "$deploy_dir/access.caddy"
cd "$deploy_dir"
docker compose config --quiet
docker compose run --rm --no-deps gateway caddy validate --config /etc/caddy/Caddyfile
printf 'Access configuration ready. Username: admin. Public gateway has NOT been started.\n'
