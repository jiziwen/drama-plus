"""在独立临时仓库核验源包清单与归档，不读取真实凭据。"""

import hashlib
import importlib.util
import json
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("package_private", pathlib.Path(__file__).with_name("package-private.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class SourcePackageTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="drama-source-package-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.email", "source-package-test@example.invalid")
        self.git("config", "user.name", "Source Package Test")
        for name in package.REQUIRED_FILES:
            self.write(name, "source\n")
        self.write(".gitignore", "backend/ignored.ts\nbackend/data/\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL)

    def write(self, name, contents):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")

    def test_untracked_source_is_included_but_secrets_media_and_generated_files_are_not(self):
        self.write("backend/src/新增服务.ts", "export const value = 1\n")
        self.write("frontend/app/components/NewPanel.vue", "<template>新功能</template>\n")
        self.write("backend/ignored.ts", "ignored\n")
        self.write("backend/data/upload.ts", "local data\n")
        unsafe = ["backend/.env.production", "backend/.npmrc", "backend/keys/private.pem",
                  "backend/private.key", "backend/state.sqlite3-wal", "frontend/local.mp4",
                  "frontend/local.wav", "frontend/.nuxt/generated.ts", "frontend/.output/public/index.html",
                  "frontend/dist/index.html", "backend/node_modules/package/index.js"]
        for name in unsafe:
            self.write(name, "secret or generated\n")
        # 即使凭据被错误加入 Git，也不能进源包。
        self.git("add", "--", "backend/private.key")
        plan, _ = package.source_plan(self.root)
        selected = {entry["path"] for entry in plan["files"]}
        self.assertIn("backend/src/新增服务.ts", selected)
        self.assertIn("frontend/app/components/NewPanel.vue", selected)
        self.assertFalse(selected.intersection(unsafe))
        self.assertNotIn("backend/ignored.ts", selected)
        self.assertNotIn("backend/data/upload.ts", selected)

    def test_dirty_content_changes_fingerprint_and_archive_matches_manifest(self):
        original, _ = package.source_plan(self.root)
        self.write("backend/package.json", "changed\n")
        plan, payloads = package.source_plan(self.root)
        self.assertNotEqual(original["sourceSha256"], plan["sourceSha256"])
        self.assertEqual(original["head"], plan["head"])
        result = package.write_bundle(self.root, self.root / "out", "private-test-r3", prepared=(plan, payloads))
        with tarfile.open(result["archive"], "r:gz") as archive:
            self.assertEqual(set(archive.getnames()), set(payloads))
            for entry in plan["files"]:
                member = archive.getmember(entry["path"])
                self.assertTrue(member.isfile())
                self.assertEqual(hashlib.sha256(archive.extractfile(member).read()).hexdigest(), entry["sha256"])
        manifest = json.loads(pathlib.Path(result["manifest"]).read_text(encoding="utf-8"))
        self.assertEqual(manifest["release"], "private-test-r3")
        self.assertEqual(manifest["archiveSha256"], result["sha256"])
        self.assertTrue(pathlib.Path(result["archive"] + ".sha256").read_text().startswith(result["sha256"] + "  "))
        with self.assertRaisesRegex(ValueError, "拒绝覆盖"):
            package.write_bundle(self.root, self.root / "out", "private-test-r3")

    def test_symlink_never_adds_files_outside_repository(self):
        target = self.root / "backend/src/linked.ts"
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.symlink_to(self.root / "Dockerfile")
        except OSError:
            self.skipTest("当前系统不允许创建符号链接")
        with self.assertRaisesRegex(ValueError, "拒绝符号链接"):
            package.source_plan(self.root)

    def test_required_source_and_release_name_are_validated(self):
        with self.assertRaisesRegex(ValueError, "发布标签"):
            package.write_bundle(self.root, self.root / "out", "../unsafe")
        (self.root / "Dockerfile").unlink()
        with self.assertRaisesRegex(ValueError, "缺少部署必需源码"):
            package.source_plan(self.root)


if __name__ == "__main__":
    unittest.main()
