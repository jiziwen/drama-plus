#!/usr/bin/env bash
# Package tracked application source only; never copy local databases or credentials.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output_dir="${1:-$repo_dir/temp/tencent-private}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
revision="$(git -C "$repo_dir" rev-parse --short=12 HEAD)"
archive="$output_dir/drama-plus-source-$revision.tar.gz"
python3 - "$repo_dir" "$archive" <<'PY'
import hashlib
import pathlib
import subprocess
import sys
import tarfile

root, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
paths = subprocess.check_output([
    'git', '-C', str(root), 'ls-files', '-z', '--',
    'Dockerfile', '.dockerignore', 'backend', 'frontend', 'docker/entrypoint.sh',
]).decode().split('\0')
paths += [
    'deploy/tencent-private/compose.yaml', 'deploy/tencent-private/compose.proxy.yaml',
    'scripts/deploy/start-private.sh',
    'scripts/deploy/install-docker.sh', 'scripts/deploy/setup-public-access.sh',
    'deploy/tencent-public/compose.yaml', 'deploy/tencent-public/Caddyfile',
]
with tarfile.open(destination, 'w:gz') as archive:
    for name in sorted(set(filter(None, paths))):
        path = pathlib.PurePosixPath(name)
        if any(part.startswith('.env') for part in path.parts):
            continue
        if any(part in {'node_modules', '.git', '.nuxt', '.output', 'data'} for part in path.parts):
            raise SystemExit(f'Refusing sensitive or generated path: {name}')
        if path.suffix.lower() in {'.pem', '.key', '.sqlite', '.sqlite3', '.db'}:
            raise SystemExit(f'Refusing credential/database file: {name}')
        source = root / name
        if source.is_file():
            archive.add(source, arcname=name, recursive=False)
print(destination)
print(hashlib.sha256(destination.read_bytes()).hexdigest())
PY
