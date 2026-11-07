"""Real Windows worker exit/restart tests, entirely under dist/release-regression."""
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2] / 'dist' / 'release-regression'
POWERSHELL = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.path = ROOT / uuid.uuid4().hex
        for folder in ('program', 'backup'):
            (self.path / folder).mkdir(parents=True)
            (self.path / folder / 'program.bin').write_text('old')
        (self.path / 'TEST_ONLY').write_text('synthetic, retained for inspection')

    def command(self, scenario='success', mode='Apply', plan='fixture-plan'):
        return [POWERSHELL, '-NoProfile', '-File', str(HERE/'ReleaseFixture.ps1'),
                '-Sandbox', str(self.path), '-Scenario', scenario, '-Mode', mode, '-PlanHash', plan]

    def run_worker(self, scenario='success', mode='Apply', plan='fixture-plan', code=0):
        result = subprocess.run(self.command(scenario, mode, plan), capture_output=True, text=True,
                                creationflags=subprocess.CREATE_NO_WINDOW, timeout=60)
        self.assertEqual(result.returncode, code, result.stderr)
        return result

    def state(self):
        return json.loads((self.path/'state/journal.json').read_text(encoding='utf-8-sig'))

    def assert_rolled_back(self):
        state = self.state()
        self.assertEqual(state['phase'], 'ROLLED_BACK')
        self.assertEqual(state['rollback'], 'VERIFIED')
        self.assertNotEqual(state['install'], 'VERIFIED')
        self.assertFalse((self.path/'launched').exists())
        self.assertEqual((self.path/'program/program.bin').read_text(), 'old')

    def test_success_requires_readiness_but_does_not_certify_continuity(self):
        self.run_worker()
        self.assertEqual(self.state()['phase'], 'READY')
        self.assertEqual(self.state()['continuity'], 'NOT_TESTED')

    def test_nonzero_install_and_rollback_are_distinct(self):
        self.run_worker('fail-install')
        self.assert_rolled_back()
        self.assertEqual(self.state()['installerExitCode'], 17)

    def test_zero_file_despite_exit_zero(self):
        self.run_worker('zero-file')
        self.assert_rolled_back()

    def test_missing_file_despite_exit_zero(self):
        self.run_worker('missing-file')
        self.assert_rolled_back()

    def test_interrupted_install_recovers_without_reinstall(self):
        self.run_worker('interrupt-install', code=23)
        self.assertEqual(self.state()['phase'], 'INSTALLING')
        self.run_worker(mode='Recover')
        self.assert_rolled_back()
        self.assertEqual((self.path/'installs').read_text(), '1')

    def test_interrupted_rollback_recovers_on_next_run(self):
        self.run_worker('interrupt-rollback', code=24)
        self.assertEqual(self.state()['rollback'], 'RUNNING')
        self.run_worker(mode='Recover')
        self.assert_rolled_back()

    def test_completed_payload_after_worker_crash_is_preserved_without_claiming_readiness(self):
        self.run_worker('interrupt-after-complete', code=23)
        self.run_worker(mode='Recover')
        self.assertEqual(self.state()['install'], 'CONTENT_VERIFIED_EXIT_UNKNOWN')
        self.assertEqual(self.state()['phase'], 'READINESS_FAILED')
        self.assertEqual(self.state()['rollback'], 'NOT_NEEDED')
        self.assertFalse((self.path/'launched').exists())
        self.assertEqual((self.path/'program/program.bin').read_text(), 'new')

    def test_logon_recovery_without_pending_transaction_is_noop(self):
        self.run_worker(mode='Recover')
        self.assertFalse((self.path/'installs').exists())

    def test_recorded_nonzero_exit_is_not_promoted_by_complete_files_after_restart(self):
        self.run_worker('interrupt-after-complete', code=23)
        state = self.state()
        state['install'] = 'FAILED'
        state['installerExitCode'] = 17
        (self.path/'state/journal.json').write_text(json.dumps(state))
        self.run_worker(mode='Recover')
        self.assert_rolled_back()
        self.assertEqual(self.state()['installerExitCode'], 17)

    def test_unknown_exit_keeps_verified_content_without_launch_or_false_success(self):
        self.run_worker('exit-unknown')
        self.assertEqual(self.state()['install'], 'CONTENT_VERIFIED_EXIT_UNKNOWN')
        self.assertEqual(self.state()['phase'], 'READINESS_FAILED')
        self.assertEqual(self.state()['rollback'], 'NOT_NEEDED')
        self.assertFalse((self.path/'launched').exists())

    def test_interruption_status_defers_inline_rollback_then_recovers_next_run(self):
        self.run_worker('interruption-status')
        self.assertEqual(self.state()['rollback'], 'DEFERRED_INTERRUPTION_STATUS')
        self.assertEqual((self.path/'program/program.bin').read_text(), 'n')
        self.run_worker(mode='Recover')
        self.assert_rolled_back()

    def test_guard_recovers_partial_install_before_launching_verified_rollback(self):
        self.run_worker('interrupt-install', code=23)
        self.run_worker(mode='Launch')
        self.assertEqual(self.state()['phase'], 'ROLLED_BACK')
        self.assertEqual((self.path/'launched').read_text(), 'rollback')

    def test_guard_refuses_unknown_installer_exit(self):
        self.run_worker('exit-unknown')
        self.run_worker(mode='Launch', code=1)
        self.assertFalse((self.path/'launched').exists())

    def test_guard_before_first_apply_requires_intact_baseline(self):
        self.run_worker(mode='Launch')
        self.assertEqual((self.path/'launched').read_text(), 'rollback')
        self.setUp()
        (self.path/'program/program.bin').write_text('broken')
        self.run_worker(mode='Launch', code=1)
        self.assertFalse((self.path/'launched').exists())

    def test_guard_serializes_launch_against_apply(self):
        (self.path/'state').mkdir()
        # A separate Windows process owns the exact lock consumed by both entry paths.
        command = [POWERSHELL, '-NoProfile', '-File', str(HERE/'ReleaseSafetyFixture.ps1'),
                   '-Sandbox', str(self.path), '-Case', 'hold-launch-lock']
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline = time.monotonic() + 15
            while not (self.path/'lock-held').exists() and time.monotonic() < deadline:
                time.sleep(.1)
            self.assertTrue((self.path/'lock-held').exists())
            self.run_worker(code=1)
            self.run_worker(mode='Launch', code=1)
            self.assertFalse((self.path/'installs').exists())
        finally:
            child.kill()
            child.communicate(timeout=10)

    def test_guard_can_launch_verified_prepared_baseline_without_installing(self):
        self.run_worker('interrupt-install', code=23)
        state = self.state()
        state.update(phase='PREPARED', install='NOT_STARTED', installerExitCode=None)
        (self.path/'state/journal.json').write_text(json.dumps(state))
        (self.path/'program/program.bin').write_text('old')
        self.run_worker(mode='Launch')
        self.assertEqual((self.path/'launched').read_text(), 'rollback')
        self.assertEqual(self.state()['phase'], 'PREPARED')

    def test_explicit_rollback_resolves_unknown_exit_without_reinstall(self):
        self.run_worker('exit-unknown')
        self.run_worker(mode='Rollback')
        self.assert_rolled_back()
        self.assertEqual((self.path/'installs').read_text(), '1')
        self.run_worker(mode='Launch')
        self.assertEqual((self.path/'launched').read_text(), 'rollback')

    def test_guard_retries_known_exit_zero_readiness_and_updates_its_journal(self):
        self.run_worker('readiness-fail')
        self.run_worker(mode='Launch')
        self.assertEqual(self.state()['phase'], 'READY')
        self.assertEqual(self.state()['installerExitCode'], 0)

    def test_failed_rollback_recovers_on_next_run(self):
        self.run_worker('fail-rollback')
        self.assertEqual(self.state()['phase'], 'ROLLBACK_FAILED')
        self.assertFalse((self.path/'launched').exists())
        self.run_worker(mode='Recover')
        self.assert_rolled_back()

    def test_live_installer_blocks_recovery_after_worker_exit(self):
        self.run_worker('interrupt-install', code=23)
        (self.path/'installer-live').write_text('synthetic active installer')
        self.run_worker(mode='Recover', code=1)
        self.assertEqual(self.state()['phase'], 'INSTALLING')
        self.assertFalse((self.path/'launched').exists())

    def test_bad_rollback_blocks_install(self):
        self.run_worker('bad-backup', code=1)
        self.assertFalse((self.path/'installs').exists())

    def test_completed_record_does_not_certify_subsequently_damaged_program(self):
        self.run_worker()
        (self.path/'program/program.bin').write_text('')
        self.run_worker(mode='Recover', code=1)
        self.assertEqual((self.path/'installs').read_text(), '1')

    def test_repeat_apply_does_not_reinstall_completed_transaction(self):
        self.run_worker()
        self.run_worker()
        self.assertEqual((self.path/'installs').read_text(), '1')

    def test_readiness_failure_does_not_rollback_running_app(self):
        self.run_worker('readiness-fail')
        self.assertEqual(self.state()['phase'], 'READINESS_FAILED')
        self.assertEqual(self.state()['install'], 'VERIFIED')
        self.assertEqual(self.state()['rollback'], 'NOT_NEEDED')

    def test_other_plan_cannot_replace_pending_journal(self):
        self.run_worker('interrupt-install', code=23)
        self.run_worker(plan='different-plan', code=1)
        self.assertEqual((self.path/'installs').read_text(), '1')

    def test_corrupt_latest_journal_is_not_silently_downgraded(self):
        self.run_worker('interrupt-install', code=23)
        (self.path/'state/journal.json').write_text('{broken')
        self.run_worker(mode='Recover', code=1)
        self.assertEqual((self.path/'installs').read_text(), '1')

    def test_concurrent_worker_refused_and_lock_released_after_kill(self):
        child = subprocess.Popen(self.command('hold-install'), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline = time.monotonic() + 20
            while not (self.path/'holding').exists() and time.monotonic() < deadline:
                time.sleep(.1)
            self.assertTrue((self.path/'holding').exists())
            self.run_worker(code=1)
        finally:
            child.kill()  # Only this test's known synthetic child; no app/model process enumeration.
            child.communicate(timeout=10)
        self.run_worker(mode='Recover')
        self.assert_rolled_back()

    def test_production_windows_safety_operations_on_isolated_inputs(self):
        for case in ['pending-rename', 'installer-child', 'orphan-nsis-uninstaller', 'prior-pid-tolerance', 'pid-reuse',
                     'other-orca', 'archive-traversal', 'additive-rollback', 'unknown-addition',
                     'path-escape', 'wrong-version', 'nsis-whitespace', 'process-exit-handle',
                     'nested-backslash-archive', 'pid-previous-boot', 'empty-version', 'partial-addition',
                     'startup-shortcut', 'plan-hash-format', 'launch-plan-missing-installer',
                     'journal-replace-failure', 'startup-shortcut-alias',
                     'renamed-run-entry', 'unreviewed-startup-target', 'startup-shortcut-hidden']:
            with self.subTest(case=case):
                self.setUp()
                result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', str(HERE/'ReleaseSafetyFixture.ps1'),
                                         '-Sandbox', str(self.path), '-Case', case], capture_output=True, text=True,
                                        creationflags=subprocess.CREATE_NO_WINDOW, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)

if __name__ == '__main__':
    unittest.main(verbosity=2)
