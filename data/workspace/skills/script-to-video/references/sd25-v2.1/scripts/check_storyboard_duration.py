#!/usr/bin/env python3
"""校验五列表格中每个“视频编号”的逐镜时长是否精确等于目标值。"""

from __future__ import annotations

import argparse
import re
import sys
from decimal import Decimal
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


HEADING_RE = re.compile(r"^\s*#{2,4}\s*视频编号\s*([0-9]+)", re.MULTILINE)
ROW_RE = re.compile(
    r"^\s*\|\s*\d+\s*\|\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*\|",
    re.MULTILINE | re.IGNORECASE,
)


def parse_sections(text: str) -> list[tuple[str, str]]:
    matches = list(HEADING_RE.finditer(text))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.append((match.group(1).zfill(2), text[start:end]))
    return sections


def format_seconds(value: Decimal) -> str:
    return format(value.normalize(), "f")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="检查每个视频编号的镜头时长总和是否精确等于目标秒数。"
    )
    parser.add_argument("storyboard", type=Path, help="待检查的 Markdown 分镜文件")
    parser.add_argument(
        "--target",
        type=Decimal,
        default=Decimal("30"),
        help="每个视频编号的精确目标时长，默认30秒",
    )
    args = parser.parse_args()

    if not args.storyboard.is_file():
        print(f"[ERROR] 文件不存在：{args.storyboard}")
        return 2

    text = args.storyboard.read_text(encoding="utf-8-sig")
    sections = parse_sections(text)
    if not sections:
        print("[ERROR] 未找到形如“## 视频编号01”的分段标题。")
        return 2

    failed = False
    for number, body in sections:
        durations = [Decimal(value) for value in ROW_RE.findall(body)]
        if not durations:
            print(f"[FAIL] 视频编号{number}：未识别到镜头时长行")
            failed = True
            continue

        total = sum(durations, Decimal("0"))
        status = "PASS" if total == args.target else "FAIL"
        detail = "+".join(format_seconds(item) for item in durations)
        print(
            f"[{status}] 视频编号{number}：{detail}="
            f"{format_seconds(total)}秒；目标={format_seconds(args.target)}秒"
        )
        failed = failed or total != args.target

    if failed:
        print("校验失败：请调整有剧情功能的镜头后重新运行，禁止用废镜头补秒。")
        return 1

    print("校验通过：全部视频编号均达到精确目标时长。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
