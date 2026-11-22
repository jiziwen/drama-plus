#!/usr/bin/env python3
"""只打包应用源码；Windows、Linux 和 macOS 使用同一份文件清单。"""

import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import subprocess
import tarfile


SOURCE_ROOTS = ("backend", "frontend", "docker")
DEPLOY_FILES = (
    "Dockerfile", ".dockerignore",
    "deploy/tencent-private/compose.yaml", "deploy/tencent-private/compose.proxy.yaml",
    "deploy/tencent-public/compose.yaml", "deploy/tencent-public/Caddyfile",
    "scripts/deploy/start-private.sh", "scripts/deploy/install-docker.sh",
    "scripts/deploy/setup-public-access.sh", "scripts/deploy/package-private.sh",
    "scripts/deploy/package-private.py",
)
REQUIRED_FILES = (
    "Dockerfile", ".dockerignore", "backend/package.json", "backend/package-lock.json",
    "frontend/package.json", "frontend/package-lock.json", "docker/entrypoint.sh",
    "deploy/tencent-private/compose.yaml", "scripts/deploy/start-private.sh",
)
EXCLUDED_DIRS = {
    "node_modules", ".git", ".nuxt", ".output", "data", "dist", "build", "release",
    "tmp", "temp", "backups", ".cache", "__pycache__", ".pytest_cache", "coverage",
    "local-runtime", "storage", "video-accounts", "keys", "secrets", "credentials",
    ".ssh", ".aws",
}
EXCLUDED_SUFFIXES = {
    ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".crt", ".cer", ".der",
    ".sqlite", ".sqlite3", ".db", ".db3", ".mdb", ".sql",
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".mp3", ".wav", ".m4a", ".flac",
    ".zip", ".tar", ".gz", ".7z", ".rar", ".bak", ".backup", ".log", ".pyc",
}
EXCLUDED_NAMES = {
    ".npmrc", ".pypirc", "credentials.json", "credential.json", "auth.json",
    "token.json", "tokens.json", "cookies.json", "cookie.txt", "cookies.txt",
    "id_rsa", "id_ed25519", "id_ecdsa", "thumbs.db", ".ds_store",
}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def exclusion_reason(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("拒绝不安全路径：" + name)
    if path.parts[0] not in SOURCE_ROOTS and name not in DEPLOY_FILES:
        return "不属于源码与部署文件白名单"
    parts = [part.lower() for part in path.parts]
    if any(part.startswith(".env") or part.startswith(".reference-media-signing-key") for part in parts):
        return "本地环境或签名密钥"
    if any(part in EXCLUDED_DIRS for part in parts):
        return "运行数据、密钥或生成目录"
    if parts[-1] in EXCLUDED_NAMES:
        return "本地凭据配置"
    if path.suffix.lower() in EXCLUDED_SUFFIXES or re.search(r"\.(?:sqlite3?|db)(?:-|\.)", parts[-1]):
        return "数据库、凭据、测试媒体或归档产物"
    return None


def source_plan(root):
    root = root.resolve()
    candidates = git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
                     *SOURCE_ROOTS, *DEPLOY_FILES).decode("utf-8").split("\0")
    entries, excluded, payloads = [], [], {}
    digest = hashlib.sha256()
    for name in sorted(set(filter(None, candidates))):
        reason = exclusion_reason(name)
        if reason:
            excluded.append({"path": name, "reason": reason})
            continue
        source = root.joinpath(*pathlib.PurePosixPath(name).parts)
        # 不跟随文件或父目录链接，也不接受根目录之外的内容。
        if any(parent.is_symlink() for parent in (source, *source.parents) if parent != root and root in parent.parents):
            raise ValueError("拒绝符号链接：" + name)
        if not source.is_file():
            excluded.append({"path": name, "reason": "工作区已删除或不是普通文件"})
            continue
        if not source.resolve().is_relative_to(root):
            raise ValueError("拒绝越界文件：" + name)
        data = source.read_bytes()
        mode = 0o755 if source.suffix.lower() == ".sh" else 0o644
        sha256 = hashlib.sha256(data).hexdigest()
        digest.update(name.encode("utf-8") + b"\0" + str(mode).encode() + b"\0" + sha256.encode() + b"\0")
        entries.append({"path": name, "size": len(data), "sha256": sha256, "mode": format(mode, "04o")})
        payloads[name] = data
    missing = set(REQUIRED_FILES) - payloads.keys()
    if missing:
        raise ValueError("缺少部署必需源码：" + "、".join(sorted(missing)))
    plan = {
        "format": 1,
        "head": git(root, "rev-parse", "HEAD").decode().strip(),
        "worktreeDirty": bool(git(root, "status", "--porcelain", "--untracked-files=normal")),
        "sourceSha256": digest.hexdigest(),
        "fileCount": len(entries),
        "totalBytes": sum(entry["size"] for entry in entries),
        "files": entries,
        "excluded": excluded,
    }
    return plan, payloads


def write_bundle(root, output_dir, release=None, *, prepared=None):
    plan, payloads = prepared or source_plan(root)
    if release is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", release):
        raise ValueError("发布标签仅支持字母、数字、点、下划线和连字符，且不能超过120字符")
    label = release or (plan["head"][:12] + "-" + plan["sourceSha256"][:12])
    name = "drama-plus-source-" + label + ".tar.gz"
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / name
    checksum = output_dir / (name + ".sha256")
    manifest = output_dir / (name + ".manifest.json")
    for output in (destination, checksum, manifest):
        if output.exists():
            raise ValueError("拒绝覆盖已有发布产物：" + str(output))
    # 从同一内存快照写包与清单；并行编辑不会改变归档中的单文件内容。
    with destination.open("xb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for entry in plan["files"]:
                    info = tarfile.TarInfo(entry["path"])
                    info.size, info.mode, info.mtime = entry["size"], int(entry["mode"], 8), 0
                    archive.addfile(info, io.BytesIO(payloads[entry["path"]]))
    sha256 = hashlib.sha256(destination.read_bytes()).hexdigest()
    checksum.write_text(sha256 + "  " + name + "\n", encoding="utf-8")
    plan.update({"release": label, "archive": name, "archiveSha256": sha256})
    manifest.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"archive": str(destination.resolve()), "sha256": sha256, "manifest": str(manifest.resolve()),
            "sourceSha256": plan["sourceSha256"], "fileCount": plan["fileCount"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", nargs="?", help="输出目录，默认 temp/tencent-private")
    parser.add_argument("--release", help="显式发布标签，如 private-20261122-3af45d5-r3；默认使用提交号和内容指纹")
    parser.add_argument("--dry-run", action="store_true", help="只输出完整文件清单、内容指纹和排除原因，不生成归档")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    try:
        prepared = source_plan(root)
        if args.dry_run:
            result = prepared[0]
        else:
            output_dir = pathlib.Path(args.output_dir) if args.output_dir else root / "temp/tencent-private"
            result = write_bundle(root, output_dir, args.release, prepared=prepared)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
