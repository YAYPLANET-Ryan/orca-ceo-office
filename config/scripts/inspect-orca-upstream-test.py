"""Real Git graph fixtures for the read-only upstream monitor."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).with_name("inspect-orca-upstream.py")
SPEC = importlib.util.spec_from_file_location("upstream_monitor", SCRIPT)
MONITOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MONITOR)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="orca-upstream-test-")
        self.addCleanup(self.sandbox.cleanup)
        self.repo = Path(self.sandbox.name)
        self.git("init", "-b", "base")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.commit("file.txt", "original\n")
        self.git("branch", "upstream")

    def git(self, *args):
        return MONITOR.git(*args, cwd=self.repo).stdout.decode("utf-8").strip()

    def commit(self, name, content):
        (self.repo / name).write_text(content, encoding="utf-8")
        self.git("add", "--", name)
        self.git("commit", "-m", "fixture")

    def inspect(self):
        before = self.git("rev-parse", "HEAD"), self.git("status", "--porcelain")
        report = MONITOR.inspect("base", "upstream", cwd=self.repo)
        self.assertEqual(before, (self.git("rev-parse", "HEAD"),
                                  self.git("status", "--porcelain")))
        self.assertFalse(report["merged"])
        return report

    def diverge(self, conflict=False):
        self.commit("file.txt", "local\n")
        self.git("checkout", "upstream")
        self.commit("file.txt" if conflict else "incoming.txt", "incoming\n")
        self.git("checkout", "base")

    def test_equal(self):
        self.assertEqual(self.inspect()["state"], "UP_TO_DATE")

    def test_ahead_has_no_incoming_changes(self):
        self.commit("local.txt", "local")
        report = self.inspect()
        self.assertEqual((report["state"], report["ahead"], report["behind"]), ("AHEAD", 1, 0))

    def test_fast_forward_still_requires_manual_review(self):
        self.git("checkout", "upstream")
        self.commit("incoming.txt", "incoming")
        self.git("checkout", "base")
        report = self.inspect()
        self.assertEqual((report["state"], report["behind"]), ("NEEDS_REVIEW", 1))
        self.assertEqual(report["conflict_check"], "not_needed")

    def test_diverged_clean(self):
        self.diverge()
        report = self.inspect()
        self.assertEqual((report["state"], report["conflict_check"]), ("NEEDS_REVIEW", "clean"))

    def test_conflicts_and_dirty_workspace_preserved(self):
        self.diverge(conflict=True)
        (self.repo / "file.txt").write_text("uncommitted\n", encoding="utf-8")
        report = self.inspect()
        self.assertEqual(report["conflict_check"], "conflicts")
        self.assertEqual(report["conflict_paths"], ["file.txt"])
        self.assertEqual((self.repo / "file.txt").read_text(), "uncommitted\n")

    def test_unrelated_histories(self):
        self.git("checkout", "--orphan", "unrelated")
        self.commit("file.txt", "other root")
        report = MONITOR.inspect("base", "unrelated", cwd=self.repo)
        self.assertEqual(report["conflict_check"], "unrelated_histories")
        self.assertEqual(report["state"], "NEEDS_REVIEW")

    def test_cli_default_review_success_strict_failure_and_infra_failure(self):
        self.diverge(conflict=True)
        output = self.repo / "report.json"
        command = [sys.executable, str(SCRIPT), "--base", "base", "--upstream", "upstream",
                   "--output", str(output)]
        env = {key: value for key, value in os.environ.items()
               if key not in {"GITHUB_STEP_SUMMARY", "FAIL_ON_REVIEW"}}
        default = subprocess.run(command, cwd=self.repo, env=env, capture_output=True)
        self.assertEqual(default.returncode, 0, default.stderr)
        self.assertEqual(json.loads(output.read_text())["state"], "NEEDS_REVIEW")
        step_summary = self.repo / "step-summary.md"
        strict = subprocess.run(command, cwd=self.repo, env={**env, "FAIL_ON_REVIEW": "1"},
                                capture_output=True)
        self.assertEqual(strict.returncode, 1)
        with_summary = subprocess.run(command, cwd=self.repo,
                                      env={**env, "GITHUB_STEP_SUMMARY": str(step_summary)},
                                      capture_output=True)
        self.assertEqual(with_summary.returncode, 0)
        self.assertIn("STATE: NEEDS_REVIEW", step_summary.read_text(encoding="utf-8"))
        self.assertIn("No code was merged", step_summary.read_text(encoding="utf-8"))
        command[command.index("upstream")] = "missing-ref"
        failed = subprocess.run(command, cwd=self.repo, env=env, capture_output=True)
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(json.loads(output.read_text())["state"], "INFRA_ERROR")

    def test_workflow_ownership_and_no_mutation_contract(self):
        workflow = (ROOT / ".github/workflows/sync-upstream.yml").read_text(encoding="utf-8-sig")
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertNotIn("contents: write", workflow)
        for forbidden in ("git merge ", "git push ", "create-pull-request", "pull-requests: write"):
            self.assertNotIn(forbidden, workflow)
        tracker = (ROOT / ".github/workflows/track-community-prs.yaml").read_text(encoding="utf-8")
        self.assertIn("if: github.repository == 'stablyai/orca'", tracker)
        self.assertNotIn("actions/checkout", tracker)


if __name__ == "__main__":
    unittest.main()
