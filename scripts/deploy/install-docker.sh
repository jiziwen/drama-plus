#!/usr/bin/env bash
# Run with sudo on Ubuntu; install only from Docker's official apt repository.
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then
  echo 'Run with sudo bash scripts/deploy/install-docker.sh' >&2
  exit 1
fi
if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version
  exit 0
fi
. /etc/os-release
if [[ "$ID" != ubuntu ]]; then
  echo 'This installation script supports Ubuntu only.' >&2
  exit 1
fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker --version
docker compose version
systemctl is-active docker
