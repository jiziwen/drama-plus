#!/usr/bin/env bash
# Windows 可直接运行 python scripts/deploy/package-private.py；其余平台兼容原入口。
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$repo_dir/scripts/deploy/package-private.py" "$@"
fi
exec python "$repo_dir/scripts/deploy/package-private.py" "$@"
