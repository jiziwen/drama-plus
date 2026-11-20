#!/usr/bin/env python3
"""Audit five-dimension storyboard Markdown for v8.2 timing and packaging invariants."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Sequence


VALID_MODES = {"STANDARD", "LONG", "ULTRA"}
VALID_DECISIONS = {
    "MERGE",
    "HARD_BOUNDARY",
    "MULTI_SUBJECT",
    "ASSET_GAP",
    "SYNC_RISK",
    "USER_LOCK",
    "NO_CONTINUITY_GAIN",
    "DURATION_LIMIT",
}


@dataclass
class Issue:
    level: str
    code: str
    message: str
    line: int | None = None


@dataclass
class MarkdownTable:
    headers: list[str]
    rows: list[tuple[int, list[str]]]
    line: int


@dataclass
class BeatRecord:
    beat_id: str
    duration: float | None
    scene: str
    subject: str
    sequence_goal: str
    hard_boundary: str
    line: int


@dataclass
class PackageRecord:
    gen_id: str
    beats: list[str]
    mode: str
    t_edit: float | None
    t_gen: float | None
    handles: str
    sequence_goal: str
    decision: str
    reason: str
    time_control: str
    fallback: str
    line: int


def clean_cell(value: str) -> str:
    value = value.strip()
    value = re.sub(r"^`|`$", "", value)
    value = value.replace("**", "").strip()
    return value


def split_pipe_row(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    return [clean_cell(cell.replace(r"\|", "|")) for cell in re.split(r"(?<!\\)\|", body)]


def is_separator_row(cells: Sequence[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells)


def parse_tables(text: str) -> list[MarkdownTable]:
    lines = text.splitlines()
    tables: list[MarkdownTable] = []
    index = 0
    while index + 1 < len(lines):
        if "|" not in lines[index] or "|" not in lines[index + 1]:
            index += 1
            continue
        headers = split_pipe_row(lines[index])
        separator = split_pipe_row(lines[index + 1])
        if len(headers) < 2 or len(separator) != len(headers) or not is_separator_row(separator):
            index += 1
            continue
        rows: list[tuple[int, list[str]]] = []
        cursor = index + 2
        while cursor < len(lines) and "|" in lines[cursor] and lines[cursor].strip().startswith("|"):
            cells = split_pipe_row(lines[cursor])
            if len(cells) == len(headers):
                rows.append((cursor + 1, cells))
            cursor += 1
        tables.append(MarkdownTable(headers=headers, rows=rows, line=index + 1))
        index = cursor
    return tables


def normalized(value: str) -> str:
    return re.sub(r"[\s_/（）()·]+", "", clean_cell(value)).upper()


def find_column(headers: Sequence[str], *needles: str, exclude: Iterable[str] = ()) -> int | None:
    excludes = tuple(normalized(item) for item in exclude)
    for index, header in enumerate(headers):
        key = normalized(header)
        if any(item in key for item in excludes):
            continue
        if any(normalized(needle) in key for needle in needles):
            return index
    return None


def cell(row: Sequence[str], index: int | None) -> str:
    return row[index].strip() if index is not None and index < len(row) else ""


def is_placeholder(value: str) -> bool:
    return not value.strip() or "{{" in value or normalized_placeholder(value) in {"-", "—", "无", "NONE", "N/A", "待定"}


def normalized_placeholder(value: str) -> str:
    return clean_cell(value).strip().upper()


def parse_seconds(value: str) -> float | None:
    if is_placeholder(value):
        return None
    match = re.search(r"(?<![:\d])(\d+(?:\.\d+)?)\s*(?:s|秒)\b", value, flags=re.IGNORECASE)
    if match:
        return float(match.group(1))
    plain = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*", value)
    return float(plain.group(1)) if plain else None


def canonical_beat(number: str) -> str:
    return f"B{int(number):02d}"


def expand_beats(value: str) -> list[str]:
    if is_placeholder(value):
        return []
    result: list[str] = []
    occupied: list[tuple[int, int]] = []
    for match in re.finditer(r"B\s*0*(\d+)\s*[–—-]\s*(?:B\s*)?0*(\d+)", value, flags=re.IGNORECASE):
        start, end = int(match.group(1)), int(match.group(2))
        if end >= start and end - start <= 500:
            result.extend(canonical_beat(str(number)) for number in range(start, end + 1))
            occupied.append(match.span())
    masked = list(value)
    for start, end in occupied:
        masked[start:end] = " " * (end - start)
    for match in re.finditer(r"B\s*0*(\d+)", "".join(masked), flags=re.IGNORECASE):
        result.append(canonical_beat(match.group(1)))
    return list(dict.fromkeys(result))


def parse_mode(value: str) -> str:
    upper = value.upper()
    for mode in VALID_MODES:
        if re.search(rf"\b{mode}\b", upper):
            return mode
    return ""


def parse_beat_tables(tables: Sequence[MarkdownTable]) -> list[BeatRecord]:
    records: list[BeatRecord] = []
    for table in tables:
        beat_index = find_column(table.headers, "B-ID")
        gen_index = find_column(table.headers, "G-ID")
        if beat_index is None or gen_index is not None:
            continue
        duration_index = find_column(table.headers, "T-BEAT", "T-EDIT")
        scene_index = find_column(table.headers, "场景/连续时间", "场景")
        subject_index = find_column(table.headers, "主要主体", "主体")
        goal_index = find_column(table.headers, "序列目标")
        boundary_index = find_column(table.headers, "硬边界")
        for line, row in table.rows:
            beats = expand_beats(cell(row, beat_index))
            if len(beats) != 1 or "{{" in "".join(row):
                continue
            records.append(
                BeatRecord(
                    beat_id=beats[0],
                    duration=parse_seconds(cell(row, duration_index)),
                    scene=cell(row, scene_index),
                    subject=cell(row, subject_index),
                    sequence_goal=cell(row, goal_index),
                    hard_boundary=cell(row, boundary_index),
                    line=line,
                )
            )
    return records


def parse_package_tables(tables: Sequence[MarkdownTable]) -> tuple[list[PackageRecord], bool]:
    records: list[PackageRecord] = []
    schema_found = False
    for table in tables:
        gen_index = find_column(table.headers, "G-ID")
        beat_index = find_column(table.headers, "B-ID覆盖", "B-ID")
        mode_index = find_column(table.headers, "MODE")
        t_gen_index = find_column(table.headers, "T-GEN")
        if gen_index is None or beat_index is None or mode_index is None or t_gen_index is None:
            continue
        schema_found = True
        t_edit_index = find_column(table.headers, "T-EDIT合计", "T-EDIT")
        handles_index = find_column(table.headers, "剪辑余量", "HANDLE")
        goal_index = find_column(table.headers, "单一序列目标", "序列目标")
        decision_index = find_column(table.headers, "判定码")
        reason_index = find_column(table.headers, "合并/不合并理由", "理由")
        time_index = find_column(table.headers, "时间控制", "NATURAL/TIMESTAMP")
        fallback_index = find_column(table.headers, "回退任务", "回退")
        for line, row in table.rows:
            gen_id = cell(row, gen_index).upper().replace(" ", "")
            if not re.fullmatch(r"G\d+", gen_id) or "{{" in "".join(row):
                continue
            records.append(
                PackageRecord(
                    gen_id=gen_id,
                    beats=expand_beats(cell(row, beat_index)),
                    mode=parse_mode(cell(row, mode_index)),
                    t_edit=parse_seconds(cell(row, t_edit_index)),
                    t_gen=parse_seconds(cell(row, t_gen_index)),
                    handles=cell(row, handles_index),
                    sequence_goal=cell(row, goal_index),
                    decision=clean_cell(cell(row, decision_index)).upper().replace(" ", ""),
                    reason=cell(row, reason_index),
                    time_control=cell(row, time_index),
                    fallback=cell(row, fallback_index),
                    line=line,
                )
            )
    return records, schema_found


def parse_prompt_records(text: str) -> list[PackageRecord]:
    records: list[PackageRecord] = []
    pattern = re.compile(
        r"^#{1,6}\s*Prompt\s+(\d+).*?SD(?:25|20)-001\s+(STANDARD|LONG|ULTRA).*?0s\s*[–—-]\s*(\d+(?:\.\d+)?)s",
        flags=re.IGNORECASE | re.MULTILINE,
    )
    for match in pattern.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        records.append(
            PackageRecord(
                gen_id=f"G{int(match.group(1)):02d}",
                beats=[],
                mode=match.group(2).upper(),
                t_edit=None,
                t_gen=float(match.group(3)),
                handles="",
                sequence_goal="",
                decision="",
                reason="",
                time_control="",
                fallback="",
                line=line,
            )
        )
    return records


def parse_legacy_timing(tables: Sequence[MarkdownTable]) -> list[tuple[float, float, int]]:
    rows: list[tuple[float, float, int]] = []
    for table in tables:
        if find_column(table.headers, "G-ID") is not None:
            continue
        edit_index = find_column(table.headers, "T-EDIT")
        gen_index = find_column(table.headers, "T-GEN")
        if edit_index is None or gen_index is None:
            continue
        for line, row in table.rows:
            edit = parse_seconds(cell(row, edit_index))
            gen = parse_seconds(cell(row, gen_index))
            if edit is not None and gen is not None:
                rows.append((edit, gen, line))
    return rows


def validate_mode_duration(record: PackageRecord, issues: list[Issue]) -> None:
    if not record.mode:
        issues.append(Issue("ERROR", "MODE001", f"{record.gen_id} 缺少有效 MODE。", record.line))
        return
    if record.t_gen is None:
        issues.append(Issue("ERROR", "TIME001", f"{record.gen_id} 缺少可解析的 T-GEN。", record.line))
        return
    ranges = {"STANDARD": (4, 15), "LONG": (16, 30), "ULTRA": (31, 180)}
    low, high = ranges[record.mode]
    if not low <= record.t_gen <= high:
        issues.append(
            Issue(
                "ERROR",
                "TIME002",
                f"{record.gen_id} 的 {record.mode} T-GEN={record.t_gen:g}s，不在 {low}–{high}s 范围。",
                record.line,
            )
        )


def validate_packages(
    packages: Sequence[PackageRecord], beats: Sequence[BeatRecord], schema_found: bool, issues: list[Issue]
) -> None:
    seen_gen: set[str] = set()
    beat_to_packages: dict[str, list[PackageRecord]] = {}
    for package in packages:
        if package.gen_id in seen_gen:
            issues.append(Issue("ERROR", "COVER001", f"G-ID 重复：{package.gen_id}。", package.line))
        seen_gen.add(package.gen_id)
        validate_mode_duration(package, issues)
        if schema_found:
            if not package.beats:
                issues.append(Issue("ERROR", "COVER002", f"{package.gen_id} 未填写 B-ID 覆盖。", package.line))
            if is_placeholder(package.sequence_goal):
                issues.append(Issue("ERROR", "GOAL001", f"{package.gen_id} 缺少单一序列目标。", package.line))
            if not package.decision:
                issues.append(Issue("ERROR", "DECIDE001", f"{package.gen_id} 缺少判定码。", package.line))
            elif package.decision not in VALID_DECISIONS:
                issues.append(
                    Issue("ERROR", "DECIDE002", f"{package.gen_id} 使用未知判定码 {package.decision}。", package.line)
                )
            if is_placeholder(package.reason):
                issues.append(Issue("ERROR", "DECIDE003", f"{package.gen_id} 缺少可观察的合并/不合并理由。", package.line))
            if is_placeholder(package.handles):
                issues.append(Issue("WARN", "EDIT001", f"{package.gen_id} 未记录剪辑余量或零余量理由。", package.line))
        for beat_id in package.beats:
            beat_to_packages.setdefault(beat_id, []).append(package)

        if package.mode == "LONG":
            if not 2 <= len(package.beats) <= 4:
                issues.append(
                    Issue("ERROR", "LONG001", f"{package.gen_id} 为 LONG，但覆盖 {len(package.beats)} 个 B-ID；应为 2–4 个。", package.line)
                )
            if schema_found and package.decision != "MERGE":
                issues.append(Issue("ERROR", "LONG002", f"{package.gen_id} 为 LONG，判定码必须为 MERGE。", package.line))
            if is_placeholder(package.fallback):
                issues.append(Issue("ERROR", "LONG003", f"{package.gen_id} 为 LONG，但缺少按 B-ID 回退方案。", package.line))
            if is_placeholder(package.time_control):
                issues.append(Issue("ERROR", "LONG004", f"{package.gen_id} 为 LONG，但缺少逐任务时间控制。", package.line))
        elif schema_found and package.mode == "STANDARD" and package.decision == "MERGE":
            issues.append(Issue("ERROR", "DECIDE004", f"{package.gen_id} 为 STANDARD，不能使用 MERGE 判定码。", package.line))

    for beat_id, owners in sorted(beat_to_packages.items()):
        if len(owners) > 1:
            issues.append(
                Issue(
                    "ERROR",
                    "COVER003",
                    f"{beat_id} 在主封装中被重复覆盖：{', '.join(item.gen_id for item in owners)}。",
                    owners[-1].line,
                )
            )

    declared = {record.beat_id for record in beats}
    covered = set(beat_to_packages)
    if declared:
        for beat_id in sorted(declared - covered):
            line = next(record.line for record in beats if record.beat_id == beat_id)
            issues.append(Issue("ERROR", "COVER004", f"导演节拍 {beat_id} 未被任何主 G-ID 覆盖。", line))
        for beat_id in sorted(covered - declared):
            owner = beat_to_packages[beat_id][0]
            issues.append(Issue("WARN", "COVER005", f"{owner.gen_id} 引用了导演节拍表中不存在的 {beat_id}。", owner.line))

    audit_fragmentation_candidates(beats, beat_to_packages, issues)


def boundary_is_clear(value: str) -> bool:
    return is_placeholder(value) or normalized(value) in {"无", "NONE", "NO"}


def audit_fragmentation_candidates(
    beats: Sequence[BeatRecord], beat_to_packages: dict[str, list[PackageRecord]], issues: list[Issue]
) -> None:
    if len(beats) < 2:
        return
    emitted: set[tuple[str, ...]] = set()
    for start in range(len(beats)):
        for length in range(2, 5):
            group = list(beats[start : start + length])
            if len(group) != length or any(item.duration is None for item in group):
                continue
            duration = sum(item.duration or 0 for item in group)
            if not 16 <= duration <= 30:
                continue
            scene = normalized(group[0].scene)
            subject = normalized(group[0].subject)
            goal = normalized(group[0].sequence_goal)
            if not scene or not subject or not goal:
                continue
            if any(normalized(item.scene) != scene or normalized(item.subject) != subject or normalized(item.sequence_goal) != goal for item in group[1:]):
                continue
            if any(not boundary_is_clear(item.hard_boundary) for item in group[1:]):
                continue
            owners = [beat_to_packages.get(item.beat_id, []) for item in group]
            if any(len(items) != 1 for items in owners):
                continue
            packages = [items[0] for items in owners]
            if any(item.mode != "STANDARD" for item in packages) or len({item.gen_id for item in packages}) != len(packages):
                continue
            key = tuple(item.beat_id for item in group)
            if key in emitted:
                continue
            emitted.add(key)
            decisions = {item.decision for item in packages}
            if not decisions or "" in decisions:
                issues.append(
                    Issue(
                        "WARN",
                        "FRAG003",
                        f"{'–'.join(key)} 合计 {duration:g}s，满足 LONG 候选条件但仍拆为 STANDARD，缺少非合并判定码。",
                        group[0].line,
                    )
                )
            elif decisions <= {"DURATION_LIMIT", "HARD_BOUNDARY"}:
                issues.append(
                    Issue(
                        "WARN",
                        "FRAG004",
                        f"{'–'.join(key)} 合计 {duration:g}s 且导演表无硬边界，非合并判定与表内事实不一致。",
                        group[0].line,
                    )
                )


def audit_text(path: Path, text: str) -> dict:
    tables = parse_tables(text)
    beats = parse_beat_tables(tables)
    packages, schema_found = parse_package_tables(tables)
    prompts = parse_prompt_records(text)
    legacy_timing = parse_legacy_timing(tables)
    issues: list[Issue] = []

    is_sd25 = "SD25-001" in text.upper()
    is_auto = "AUTO-HYBRID" in text.upper()
    standard_only = "STANDARD-ONLY" in text.upper()

    if packages:
        validate_packages(packages, beats, schema_found, issues)
        active = packages
    else:
        active = prompts
        for record in prompts:
            validate_mode_duration(record, issues)
        if is_sd25 and is_auto:
            issues.append(Issue("ERROR", "PKG001", "项目声明 AUTO-HYBRID，但没有可解析的 G-ID 生成封装表。"))
        elif is_sd25 and len(prompts) >= 6:
            issues.append(Issue("WARN", "PKG002", "SD25 多任务输出没有 B-ID/G-ID 生成封装表，无法审计 LONG 候选与节拍覆盖。"))

    if is_sd25 and len(active) >= 8 and not standard_only:
        modes = [record.mode for record in active if record.mode]
        if modes and all(mode == "STANDARD" for mode in modes):
            issues.append(
                Issue(
                    "WARN",
                    "FRAG001",
                    f"{len(modes)} 个 SD25 主任务全部为 STANDARD；应执行 LONG 候选审计，或明确锁定 STANDARD-ONLY。",
                )
            )
        durations = [record.t_gen for record in active if record.t_gen is not None]
        if durations and sum(value <= 10 for value in durations) / len(durations) >= 0.8 and not any(
            record.mode in {"LONG", "ULTRA"} for record in active
        ):
            issues.append(
                Issue(
                    "WARN",
                    "FRAG002",
                    f"{sum(value <= 10 for value in durations)}/{len(durations)} 个任务不超过 10 秒，且没有 LONG/ULTRA；检查是否把 T-BEAT 机械等同为 T-GEN。",
                )
            )

    if legacy_timing:
        equal_count = sum(abs(edit - gen) < 1e-9 for edit, gen, _ in legacy_timing)
        if len(legacy_timing) >= 4 and equal_count / len(legacy_timing) >= 0.8:
            issues.append(
                Issue(
                    "WARN",
                    "EDIT002",
                    f"{equal_count}/{len(legacy_timing)} 个时长记录 T-EDIT=T-GEN；请记录剪辑余量，或说明零余量理由。",
                    legacy_timing[0][2],
                )
            )

    errors = sum(issue.level == "ERROR" for issue in issues)
    warnings = sum(issue.level == "WARN" for issue in issues)
    return {
        "path": str(path),
        "platform": "SD25-001" if is_sd25 else ("SD20-001" if "SD20-001" in text.upper() else "unknown"),
        "mode_policy": "AUTO-HYBRID" if is_auto else ("STANDARD-ONLY" if standard_only else "unspecified/locked"),
        "beat_count": len(beats),
        "package_count": len(packages),
        "prompt_count": len(prompts),
        "errors": errors,
        "warnings": warnings,
        "issues": [asdict(issue) for issue in issues],
    }


def read_text(path: Path) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise UnicodeError(f"无法识别文本编码：{path}")


def print_report(report: dict) -> None:
    print(f"审计：{report['path']}")
    print(
        f"平台={report['platform']}  模式策略={report['mode_policy']}  "
        f"B-ID={report['beat_count']}  G-ID={report['package_count']}  Prompt={report['prompt_count']}"
    )
    for issue in report["issues"]:
        location = f" line {issue['line']}" if issue["line"] else ""
        print(f"[{issue['level']}] {issue['code']}{location}: {issue['message']}")
    print(f"结果：{report['errors']} error(s), {report['warnings']} warning(s)")


def main(argv: Sequence[str] | None = None) -> int:
    if not sys.stdout.isatty() and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="Storyboard Markdown file(s)")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of human-readable reports")
    args = parser.parse_args(argv)

    reports: list[dict] = []
    for path in args.paths:
        try:
            reports.append(audit_text(path, read_text(path)))
        except (OSError, UnicodeError) as exc:
            reports.append(
                {
                    "path": str(path),
                    "platform": "unknown",
                    "mode_policy": "unknown",
                    "beat_count": 0,
                    "package_count": 0,
                    "prompt_count": 0,
                    "errors": 1,
                    "warnings": 0,
                    "issues": [asdict(Issue("ERROR", "FILE001", str(exc)))],
                }
            )

    if args.json:
        print(json.dumps(reports, ensure_ascii=False, indent=2))
    else:
        for index, report in enumerate(reports):
            if index:
                print()
            print_report(report)

    if any(report["errors"] for report in reports):
        return 2
    if any(report["warnings"] for report in reports):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
