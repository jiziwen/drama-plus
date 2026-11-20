from pathlib import Path
import unittest

from audit_storyboard import audit_text


GOOD_HYBRID = """
平台配置：SD25-001
模式策略：AUTO-HYBRID

| B-ID | E-TC | T-BEAT | 场景/连续时间 | 主要主体 | 主动作 | 序列目标 | 摄影语法 | 硬边界 | 必需尾帧 |
|---|---|---:|---|---|---|---|---|---|---|
| B01 | 00:00–00:08 | 8s | 舞台/连续 | 角色甲 | 起身 | 完成登台 | 中景推近 | 无 | 站稳 |
| B02 | 00:08–00:16 | 8s | 舞台/连续 | 角色甲 | 挥棒 | 完成登台 | 低机位横移 | 无 | 棒势停住 |
| B03 | 00:16–00:24 | 8s | 后台/连续 | 角色乙 | 回望 | 确认出口 | 近景定镜 | 换场 | 面向出口 |

| G-ID | B-ID覆盖 | MODE | T-EDIT合计 | T-GEN | 剪辑余量 | 单一序列目标 | 判定码 | 合并/不合并理由 | 时间控制 | 回退任务 |
|---|---|---|---:|---:|---|---|---|---|---|---|
| G01 | B01–B02 | LONG | 16s | 18s | 入1s/出1s | 完成登台 | MERGE | 同场连续动作，合并维持棒势 | Timestamp | B01、B02 STANDARD |
| G02 | B03 | STANDARD | 8s | 10s | 入1s/出1s | 确认出口 | NO_CONTINUITY_GAIN | 换场后的独立反应 | Natural | 无 |
"""


BAD_LONG = """
平台配置：SD25-001
模式策略：AUTO-HYBRID

| B-ID | E-TC | T-BEAT | 场景/连续时间 | 主要主体 | 主动作 | 序列目标 | 摄影语法 | 硬边界 | 必需尾帧 |
|---|---|---:|---|---|---|---|---|---|---|
| B01 | 00:00–00:08 | 8s | 舞台/连续 | 角色甲 | 起身 | 完成登台 | 中景推近 | 无 | 站稳 |

| G-ID | B-ID覆盖 | MODE | T-EDIT合计 | T-GEN | 剪辑余量 | 单一序列目标 | 判定码 | 合并/不合并理由 | 时间控制 | 回退任务 |
|---|---|---|---:|---:|---|---|---|---|---|---|
| G01 | B01 | LONG | 8s | 12s | — | — | HARD_BOUNDARY | — | — | — |
"""


class AuditStoryboardTests(unittest.TestCase):
    def test_valid_hybrid_package_passes(self):
        report = audit_text(Path("good.md"), GOOD_HYBRID)
        self.assertEqual(report["errors"], 0)
        self.assertEqual(report["warnings"], 0)
        self.assertEqual(report["beat_count"], 3)
        self.assertEqual(report["package_count"], 2)

    def test_invalid_long_fails_invariants(self):
        report = audit_text(Path("bad.md"), BAD_LONG)
        codes = {issue["code"] for issue in report["issues"]}
        self.assertIn("TIME002", codes)
        self.assertIn("LONG001", codes)
        self.assertIn("LONG002", codes)
        self.assertIn("LONG003", codes)
        self.assertIn("LONG004", codes)
        self.assertGreater(report["errors"], 0)


if __name__ == "__main__":
    unittest.main()
