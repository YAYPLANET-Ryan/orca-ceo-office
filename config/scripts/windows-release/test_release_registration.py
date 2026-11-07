"""Actual registration entry/journals/LNKs, synthetic Scheduler and platform scope."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

HERE=Path(__file__).resolve().parent
PS=str(Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe')

class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.root=HERE.parents[2]/'dist/release-regression'/uuid.uuid4().hex
        self.root.mkdir(parents=True)
        (self.root/'TEST_ONLY').write_text('isolated registration fixture')
        self.run_entry('Prepare')

    def command(self,mode='Run',scenario='success'):
        return [PS,'-NoProfile','-File',str(HERE/'RegistrationFixture.ps1'),'-Sandbox',str(self.root),'-Mode',mode,'-Scenario',scenario]

    def run_entry(self,mode='Run',scenario='success',code=0):
        result=subprocess.run(self.command(mode,scenario),capture_output=True,text=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,code,result.stderr)
        return result

    def journal(self):
        return json.loads((self.root/'state/registration.json').read_text(encoding='utf-8-sig'))

    def tasks(self):
        return list((self.root/'scheduler').glob('*.json'))

    def test_preview_has_no_registration_or_shortcut_changes(self):
        original=(self.root/'startup/Orca.lnk').read_bytes()
        preview=json.loads(self.run_entry('Preview').stdout)
        self.assertTrue(preview['deploymentEligible'])
        self.assertEqual((self.root/'startup/Orca.lnk').read_bytes(),original)
        self.assertFalse((self.root/'state/registration.json').exists())
        self.assertEqual(self.tasks(),[])

    def test_success_pins_actions_and_shortcut_history(self):
        preview=json.loads(self.run_entry('Preview').stdout)
        self.run_entry()
        journal=self.journal()
        self.assertEqual(journal['phase'],'REGISTERED')
        self.assertEqual(len(journal['createdTasks']),2)
        self.assertEqual(len(self.tasks()),2)
        inspection=json.loads(self.run_entry('Inspect').stdout)
        self.assertFalse(inspection['liveWrites'])
        self.assertTrue(all(t['status']=='FOUND' for t in inspection['tasks']))
        self.assertTrue(all(t['actionMatchesRecordedIntent'] for t in inspection['tasks']))
        link=journal['shortcuts'][0]
        self.assertEqual(hashlib.sha256(Path(link['backupPath']).read_bytes()).hexdigest(),link['originalSha256'])
        self.assertEqual(hashlib.sha256(Path(link['path']).read_bytes()).hexdigest(),link['routedSha256'])
        for path in self.tasks():
            task=json.loads(path.read_text(encoding='utf-8-sig'))
            self.assertIn('-ExpectedBundleSha256 '+journal['bundleHash'],task['action']['argument'])
            self.assertIn('-ExpectedPlanSha256 '+journal['planHash'],task['action']['argument'])
            self.assertIn('-ExecutionPolicy Bypass',task['action']['argument'])
            self.assertEqual(task['settings']['instances'],'IgnoreNew')
            if path.stem.endswith('-Recover'):
                self.assertEqual(task['action']['argument'],preview['plannedGateArguments'])

    def test_recover_failure_preserves_only_on_demand_apply_and_retry_refuses(self):
        self.run_entry(scenario='fail-recover',code=1)
        journal=self.journal()
        self.assertEqual(journal['phase'],'RECONCILIATION_REQUIRED')
        self.assertEqual(len(journal['createdTasks']),1)
        self.assertTrue(journal['createdTasks'][0].endswith('-Apply'))
        self.assertEqual(len(self.tasks()),1)
        original=(self.root/'state/registration.json').read_bytes()
        self.run_entry(code=1)
        self.assertEqual((self.root/'state/registration.json').read_bytes(),original)
        self.assertEqual(len(self.tasks()),1)

    def test_crash_after_scheduler_write_keeps_pending_intent_and_blocks_retry(self):
        self.run_entry(scenario='crash-recover',code=31)
        journal=self.journal()
        self.assertEqual(journal['phase'],'REGISTERING_Recover')
        self.assertEqual(len(journal['createdTasks']),1)
        self.assertTrue(journal['createdTasks'][0].endswith('-Apply'))
        self.assertEqual(len(self.tasks()),2)
        inspection=json.loads(self.run_entry('Inspect').stdout)
        unrecorded=[t for t in inspection['tasks'] if t['appearedBeforeJournal']]
        self.assertEqual(len(unrecorded),1)
        self.assertEqual(unrecorded[0]['mode'],'Recover')
        original=(self.root/'state/registration.json').read_bytes()
        self.run_entry(code=1)
        self.assertEqual((self.root/'state/registration.json').read_bytes(),original)

    def test_crash_after_shortcut_write_preserves_original_and_does_not_register_tasks(self):
        self.run_entry(scenario='crash-routing',code=32)
        journal=self.journal()
        self.assertEqual(journal['phase'],'ROUTING')
        link=journal['shortcuts'][0]
        self.assertEqual(hashlib.sha256(Path(link['backupPath']).read_bytes()).hexdigest(),link['originalSha256'])
        self.assertNotEqual(hashlib.sha256(Path(link['path']).read_bytes()).hexdigest(),link['originalSha256'])
        self.assertEqual(self.tasks(),[])
        inspection=json.loads(self.run_entry('Inspect').stdout)
        self.assertTrue(inspection['shortcuts'][0]['backupVerified'])
        self.assertEqual(inspection['shortcuts'][0]['status'],'ROUTED_HASH_VERIFIED')
        self.run_entry(code=1)

    def test_duplicate_worker_refuses_and_crash_releases_locks(self):
        child=subprocess.Popen(self.command(scenario='hold-recover'),stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline=time.monotonic()+20
            while not (self.root/'holding').exists() and time.monotonic()<deadline:
                time.sleep(.1)
            self.assertTrue((self.root/'holding').exists())
            self.run_entry(code=1)
            self.assertEqual(len(self.tasks()),2)
        finally:
            child.kill()  # Only this fixture worker, never an app/model process.
            child.communicate(timeout=10)
        before=(self.root/'state/registration.json').read_bytes()
        self.run_entry(code=1)
        self.assertEqual((self.root/'state/registration.json').read_bytes(),before)

    def test_apply_failure_never_creates_logon_task(self):
        self.run_entry(scenario='fail-apply',code=1)
        self.assertEqual(self.journal()['phase'],'RECONCILIATION_REQUIRED')
        self.assertEqual(self.tasks(),[])

    def test_added_shortcut_between_preview_and_apply_is_refused(self):
        self.run_entry(scenario='drift-added',code=1)
        self.assertEqual(self.journal()['phase'],'RECONCILIATION_REQUIRED')
        self.assertEqual(self.tasks(),[])
        self.assertEqual(list((self.root/'state').glob('startup-shortcuts/*.original')),[])

    def test_uppercase_hashes_are_valid_and_canonicalized(self):
        self.run_entry(scenario='uppercase-hashes')
        journal=self.journal()
        self.assertEqual(journal['phase'],'REGISTERED')
        self.assertEqual(journal['planHash'],journal['planHash'].lower())

    def test_second_shortcut_failure_preserves_first_item_journal_and_backup(self):
        self.run_entry(scenario='second-link-failure',code=1)
        journal=self.journal()
        self.assertEqual(journal['phase'],'RECONCILIATION_REQUIRED')
        first=next(s for s in journal['shortcuts'] if s['path'].endswith('Orca.lnk'))
        second=next(s for s in journal['shortcuts'] if s['path'].endswith('ZZ-Second.lnk'))
        self.assertEqual(first['status'],'ROUTED')
        self.assertEqual(hashlib.sha256(Path(first['path']).read_bytes()).hexdigest(),first['routedSha256'])
        self.assertEqual(second['status'],'BACKUP_PENDING')
        self.assertEqual(self.tasks(),[])
        inspection=json.loads(self.run_entry('Inspect').stdout)
        self.assertEqual({s['status'] for s in inspection['shortcuts']},{'ORIGINAL','ROUTED_HASH_VERIFIED'})

    def test_inspector_detects_task_action_drift_without_writing(self):
        self.run_entry()
        path=self.tasks()[0]
        task=json.loads(path.read_text(encoding='utf-8-sig'))
        task['action']['argument']='unexpected fixture action'
        path.write_text(json.dumps(task))
        before=(self.root/'state/registration.json').read_bytes()
        inspection=json.loads(self.run_entry('Inspect').stdout)
        self.assertEqual(sum(t['actionMatchesRecordedIntent'] is False for t in inspection['tasks']),1)
        self.assertEqual((self.root/'state/registration.json').read_bytes(),before)

    def test_inspector_preserves_and_reports_corrupt_journal(self):
        path=self.root/'state/registration.json'
        path.write_bytes(b'{truncated')
        inspection=json.loads(self.run_entry('Inspect').stdout)
        self.assertEqual(inspection['result'],'CORRUPT_JOURNAL')
        self.assertEqual(path.read_bytes(),b'{truncated')

    def test_noncanonical_plan_root_is_recorded_canonically(self):
        self.run_entry(scenario='noncanonical-root')
        self.assertEqual(self.journal()['root'],str(self.root/'program'))
        self.assertEqual(json.loads(self.run_entry('Inspect').stdout)['result'],'INSPECTED_NOT_RECONCILED')

    def test_crash_after_copy_before_backup_journal_is_read_only_reconcilable(self):
        self.run_entry(scenario='crash-after-copy',code=33)
        self.assertEqual(self.journal()['shortcuts'][0]['status'],'BACKUP_PENDING')
        inspection=json.loads(self.run_entry('Inspect').stdout)
        self.assertEqual(inspection['shortcuts'][0]['status'],'ORIGINAL')
        self.assertTrue(inspection['shortcuts'][0]['backupVerified'])
        self.assertEqual(self.tasks(),[])

    def test_crash_after_save_before_routed_journal_stays_uncertain(self):
        self.run_entry(scenario='crash-after-save',code=34)
        self.assertEqual(self.journal()['shortcuts'][0]['status'],'ROUTING')
        inspection=json.loads(self.run_entry('Inspect').stdout)
        self.assertEqual(inspection['shortcuts'][0]['status'],'MODIFIED_OR_UNRECORDED_ROUTING')
        self.assertTrue(inspection['shortcuts'][0]['backupVerified'])
        self.assertEqual(self.tasks(),[])

if __name__=='__main__':
    unittest.main()
