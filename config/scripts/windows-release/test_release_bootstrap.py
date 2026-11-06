"""Isolated metadata, immutable helper and deferred-readiness regressions."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest
import uuid

HERE = Path(__file__).resolve().parent
PS = str(Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe')

class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.root = HERE.parents[2]/'dist/release-regression'/uuid.uuid4().hex
        self.root.mkdir(parents=True)
        (self.root/'TEST_ONLY').write_text('synthetic fixtures only')

    def ps(self, body, success=True):
        script = self.root/(uuid.uuid4().hex+'.ps1')
        script.write_text("$ErrorActionPreference='Stop'\n"+body, encoding='utf-8')
        result = subprocess.run([PS,'-NoProfile','-File',str(script)], capture_output=True, text=True,
                                timeout=90, creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode == 0, success, result.stderr+result.stdout)
        return result

    def test_known_incomplete_state_and_refusals(self):
        program = self.root/'program'
        names = ['Orca.exe','resources/app.asar','resources/bin/orca.exe','resources.pak','icudtl.dat']
        entries = []
        for name in names:
            file = program/name
            file.parent.mkdir(parents=True,exist_ok=True)
            if name != names[2]:
                file.write_bytes(b'fixture')
            entries.append(dict(path=name,size=7,sha256=hashlib.sha256(b'fixture').hexdigest(),requiredNonempty=True))
        manifest = self.root/'manifest.json'
        manifest.write_text(json.dumps(dict(files=entries)))
        body = f". '{HERE}/BootstrapFingerprint.ps1'\n$m=Get-Content '{manifest}' -Raw|ConvertFrom-Json\nAssert-KnownIncompleteProgram '{program}' $m @('resources/bin/orca.exe')\n"
        self.ps(body)
        for name, content in [('extra.bin',b'x'),('resources.pak',b''),('Orca.exe',b'changed'),('resources/bin/orca.exe',b'fixture')]:
            file = program/name
            previous = file.read_bytes() if file.exists() else None
            file.write_bytes(content)
            self.ps(body, False)
            if previous is None:
                file.unlink()  # Own newly-created fixture only.
            else:
                file.write_bytes(previous)

    def test_deferred_install_never_launches_and_replay_does_not_reinstall(self):
        for folder in ['program','backup']:
            (self.root/folder).mkdir()
            (self.root/folder/'program.bin').write_text('old')
        command = [PS,'-NoProfile','-File',str(HERE/'ReleaseFixture.ps1'),'-Sandbox',str(self.root),'-DeferReadiness']
        for mode in ['Apply','Recover','Apply']:
            result = subprocess.run(command+['-Mode',mode],capture_output=True,text=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode,0,result.stderr)
            state = json.loads((self.root/'state/journal.json').read_text(encoding='utf-8-sig'))
            self.assertEqual(state['phase'],'READINESS_FAILED')
            self.assertEqual(state['readiness'],'DEFERRED_MAINTENANCE_FINALIZATION')
            self.assertEqual(state['continuity'],'NOT_TESTED')
            self.assertFalse((self.root/'launched').exists())
        self.assertEqual((self.root/'installs').read_text(),'1')

    def test_known_zero_exit_crash_recovers_into_deferred_state(self):
        for folder in ['program','backup']:
            (self.root/folder).mkdir()
            (self.root/folder/'program.bin').write_text('old')
        command=[PS,'-NoProfile','-File',str(HERE/'ReleaseFixture.ps1'),'-Sandbox',str(self.root),'-DeferReadiness']
        result=subprocess.run(command+['-Scenario','interrupt-after-complete'],capture_output=True,text=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,23,result.stderr)
        path=self.root/'state/journal.json'
        state=json.loads(path.read_text(encoding='utf-8-sig'))
        state.update(phase='VERIFYING',installerExitCode=0)
        path.write_text(json.dumps(state))
        result=subprocess.run(command+['-Mode','Recover'],capture_output=True,text=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,0,result.stderr)
        state=json.loads(path.read_text(encoding='utf-8-sig'))
        self.assertEqual(state['readiness'],'DEFERRED_MAINTENANCE_FINALIZATION')
        self.assertEqual(state['install'],'VERIFIED')
        self.assertFalse((self.root/'launched').exists())

    def test_terminal_transition_refuses_pending_unknown_or_other_plan(self):
        self.ps(f""". '{HERE}/ReleasePlanTransition.ps1'
$s=[pscustomobject]@{{root='fixture';planHash='old';phase='READY';install='VERIFIED';rollback='NOT_NEEDED';installerExitCode=0;readiness='WINDOW_AND_SERVER_READY'}}
Assert-ReleaseTransitionState $s 'fixture' 'old' -ToBootstrap
$s.phase='ROLLED_BACK';$s.rollback='VERIFIED';Assert-ReleaseTransitionState $s 'fixture' 'old' -ToBootstrap
foreach($phase in @('PREPARED','INSTALLING','VERIFYING','ROLLING_BACK','ROLLBACK_FAILED','READINESS_FAILED')){{$s.phase=$phase;$blocked=$false;try{{Assert-ReleaseTransitionState $s 'fixture' 'old' -ToBootstrap}}catch{{$blocked=$true}};if(-not $blocked){{throw ('Pending phase accepted: '+$phase)}}}}
$s.phase='READY';$s.installerExitCode=$null;$blocked=$false;try{{Assert-ReleaseTransitionState $s 'fixture' 'old' -ToBootstrap}}catch{{$blocked=$true}};if(-not $blocked){{throw 'Unknown exit accepted'}}
$s.phase='READINESS_FAILED';$s.installerExitCode=0;$s.readiness='DEFERRED_MAINTENANCE_FINALIZATION';Assert-ReleaseTransitionState $s 'fixture' 'old'
$s.phase='ROLLED_BACK';$s.install='FAILED';$s.rollback='VERIFIED';Assert-ReleaseTransitionState $s 'fixture' 'old'
$blocked=$false;try{{Assert-ReleaseTransitionState $s 'fixture' 'other'}}catch{{$blocked=$true}};if(-not $blocked){{throw 'Wrong plan accepted'}}
""")

    def test_transition_entry_copies_history_and_replays_without_overwrite(self):
        # Replace platform/artifact eligibility only; real entry, locks, state
        # predicate, hash checks and journal writer run against retained fixtures.
        helper=self.root/'helpers';helper.mkdir()
        for name in ['Transition-VerifiedReleasePlan.ps1','ReleasePlanTransition.ps1','ReleaseIntegrity.ps1']:
            (helper/name).write_bytes((HERE/name).read_bytes())
        # The transition module dot-sources Integrity again; install the path
        # boundary stub after that import, so it cannot address the real state root.
        with (helper/'ReleasePlanTransition.ps1').open('a',encoding='utf-8') as handle:
            handle.write(f"\nfunction Get-ReleaseStateDirectory {{param($Root) '{self.root}/state'}}\n")
        (helper/'BootstrapRepair.ps1').write_text(f""". '{HERE}/ReleaseIntegrity.ps1'
function Assert-BootstrapExecutionIdentity {{param($Root) if(-not(Test-Path '{self.root}/TEST_ONLY')){{throw 'Not a fixture'}}}}
function Assert-BootstrapRepairPlan {{param($Plan,[switch]$ForRecovery)}}
function Assert-ReleasePlan {{param($Plan,[switch]$ForLaunch)}}
function Assert-ReleaseIdle {{param($Plan,$State)}}
function Assert-ReleaseVersion {{param($Root,$Version)}}
function Get-ReleaseStateDirectory {{param($Root) '{self.root}/state'}}
""")
        program=self.root/'program';program.mkdir();(program/'program.bin').write_bytes(b'old')
        manifest=dict(files=[dict(path='program.bin',size=3,sha256=hashlib.sha256(b'old').hexdigest(),requiredNonempty=True)])
        old=dict(version='1',installRoot=str(program),candidate=manifest,rollback=dict(version='1',manifest=manifest),bootstrap=dict(kind='R0_SAME_VERSION'))
        new=dict(version='2',installRoot=str(program),candidate=manifest,rollback=dict(version='1',manifest=manifest))
        plans=[]
        for name,plan in [('old',old),('new',new)]:
            path=self.root/(name+'.json');path.write_text(json.dumps(plan));plans.append((path,hashlib.sha256(path.read_bytes()).hexdigest()))
        state_dir=self.root/'state';state_dir.mkdir();journal=state_dir/'journal.json'
        state=dict(schema=1,root=str(program),planHash=plans[0][1],phase='ROLLED_BACK',install='FAILED',rollback='VERIFIED',installerExitCode=17,readiness='NOT_TESTED',updatedAt='')
        journal.write_text(json.dumps(state));before=journal.read_bytes()
        command=[PS,'-NoProfile','-File',str(helper/'Transition-VerifiedReleasePlan.ps1'),'-PreviousPlanPath',str(plans[0][0]),'-PreviousPlanSha256',plans[0][1],'-PlanPath',str(plans[1][0]),'-ExpectedPlanSha256',plans[1][1]]
        for attempt,apply in enumerate([False,True,True]):
            result=subprocess.run(command+(['-Apply'] if apply else []),capture_output=True,text=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
            if attempt==2:
                self.assertNotEqual(result.returncode,0,'Replay must refuse the changed plan journal')
                self.assertEqual(len(list(state_dir.glob('journal-history-*'))),1)
                continue
            self.assertEqual(result.returncode,0,result.stderr)
            if not apply:self.assertEqual(journal.read_bytes(),before)
        after=json.loads(journal.read_text(encoding='utf-8-sig'))
        self.assertEqual(after['phase'],'PREPARED');self.assertEqual(after['previousInstallOutcome'],'FAILED')
        history=Path(after['previousJournal']);self.assertEqual(history.read_bytes(),before)
        self.assertEqual(after['previousJournalSha256'],hashlib.sha256(before).hexdigest())

    def test_bundle_freeze_verify_tamper_extra_and_no_overwrite(self):
        source=self.root/'source'; source.mkdir()
        # Harmless stand-in entry verifies argument forwarding and exit status.
        (source/'Invoke-VerifiedRelease.ps1').write_text('param($PlanPath,$ExpectedPlanSha256,$Mode)\nif($Mode -ne "Inspect"){exit 9}\nexit 7')
        (source/'Invoke-ReleaseBundleEntry.ps1').write_bytes((HERE/'Invoke-ReleaseBundleEntry.ps1').read_bytes())
        bundle=self.root/'bundle'; pin=self.root/'pin.txt'
        self.ps(f". '{HERE}/ReleaseHelperBundle.ps1'\n$b=New-ReleaseHelperBundle '{source}' '{bundle}' ('a'*40)\n$b.manifestSha256|Set-Content '{pin}'")
        digest=pin.read_text().strip()
        check=f". '{HERE}/ReleaseHelperBundle.ps1'\nAssert-ReleaseHelperBundle '{bundle}' '{digest}'|Out-Null"
        self.ps(check)
        self.ps(f". '{HERE}/ReleaseHelperBundle.ps1'\nNew-ReleaseHelperBundle '{source}' '{bundle}' ('a'*40)",False)
        result=subprocess.run([PS,'-NoProfile','-File',str(bundle/'Invoke-ReleaseBundleEntry.ps1'),'-ExpectedBundleSha256',digest,'-Entry','Invoke-VerifiedRelease.ps1','-PlanPath',str(self.root/'unused.json'),'-ExpectedPlanSha256','b'*64,'-Mode','Inspect'],capture_output=True,text=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,7,result.stderr)
        (bundle/'extra.ps1').write_text('exit 0')
        self.ps(check,False)
        (bundle/'extra.ps1').unlink()
        (bundle/'Invoke-VerifiedRelease.ps1').write_text('exit 0')
        self.ps(check,False)

    def test_security_evidence_exact_hash_time_scans_and_vendor_artifact(self):
        body=f""". '{HERE}/ReleaseSecurityEvidence.ps1'
$dir='{self.root}'
$vendor=Join-Path $dir 'synthetic-vendor.txt';[IO.File]::WriteAllText($vendor,'TEST ONLY, NOT REAL SECURITY CLEARANCE')
$hash='a'*64;$cli=[pscustomobject]@{{files=@([pscustomobject]@{{path='resources/bin/orca.exe';size=7;sha256=$hash}})}}
$plan=[pscustomobject]@{{candidate=$cli;installer=[pscustomobject]@{{sha256=$hash}};rollback=[pscustomobject]@{{sha256=$hash;manifest=$cli}};bootstrap=[pscustomobject]@{{embeddedCliSha256=$hash;securityEvidence=[pscustomobject]@{{path=(Join-Path $dir 'security.json');sha256=''}}}}}}
$end=[DateTime]::UtcNow.AddMinutes(-1);$start=$end.AddHours(-2)
$proof=[pscustomobject]@{{schema=1;decision='FALSE_POSITIVE_RESOLVED';vendorStatementPath=$vendor;vendorStatementSha256=(Get-ReleaseHash $vendor);installerSha256=$hash;rollbackSha256=$hash;cliSha256=$hash;observationStartedAt=$start.ToString('o');observationEndedAt=$end.ToString('o');engineVersion='SYNTHETIC';definitionsVersion='SYNTHETIC';scans=@([pscustomobject]@{{at=$start.ToString('o');result='CLEAN';engineVersion='SYNTHETIC';definitionsVersion='SYNTHETIC'}},[pscustomobject]@{{at=$end.ToString('o');result='CLEAN';engineVersion='SYNTHETIC';definitionsVersion='SYNTHETIC'}})}}
foreach($scan in $proof.scans){{foreach($key in @('cliSha256','installerSha256','rollbackSha256')){{$scan|Add-Member NoteProperty $key $hash}};$scan|Add-Member NoteProperty reportPath $vendor;$scan|Add-Member NoteProperty reportSha256 (Get-ReleaseHash $vendor)}}
function Check {{ $proof|ConvertTo-Json -Depth 8|Set-Content $plan.bootstrap.securityEvidence.path;$plan.bootstrap.securityEvidence.sha256=Get-ReleaseHash $plan.bootstrap.securityEvidence.path;Assert-BootstrapSecurityEvidence $plan }}
Check
foreach($case in @('decision','hash','stale','future','scan','vendor')){{
 $copy=$proof|ConvertTo-Json -Depth 8
 switch($case){{'decision'{{$proof.decision='PENDING'}} 'hash'{{$proof.cliSha256='b'*64}} 'stale'{{$proof.observationEndedAt=$end.AddDays(-2).ToString('o')}} 'future'{{$proof.scans[1].at=$end.AddDays(1).ToString('o')}} 'scan'{{$proof.scans[0].result='DETECTED'}} 'vendor'{{$proof.vendorStatementSha256='c'*64}}}}
 $blocked=$false;try{{Check}}catch{{$blocked=$true}};if(-not $blocked){{throw ('Unsafe security evidence accepted: '+$case)}}
 $proof=$copy|ConvertFrom-Json
}}
$proof.observationStartedAt=$start.AddDays(-2).ToString('o');$proof.observationEndedAt=$end.AddDays(-2).ToString('o');$proof.scans[0].at=$start.AddDays(-2).ToString('o');$proof.scans[1].at=$end.AddDays(-2).ToString('o')
$proof|ConvertTo-Json -Depth 8|Set-Content $plan.bootstrap.securityEvidence.path;$plan.bootstrap.securityEvidence.sha256=Get-ReleaseHash $plan.bootstrap.securityEvidence.path
$blocked=$false;try{{Assert-BootstrapSecurityEvidence $plan}}catch{{$blocked=$true}};if(-not $blocked){{throw 'Stale new-install evidence accepted'}}
Assert-BootstrapSecurityEvidence $plan -ForRecovery
"""
        self.ps(body)

    def test_regular_path_rejects_bootstrap_plan_before_artifact_access(self):
        self.ps(f". '{HERE}/WindowsReleaseOperations.ps1'\nAssert-ReleasePlan ([pscustomobject]@{{schema=1;bootstrap=@{{kind='R0_SAME_VERSION'}}}})",False)

    def test_pinned_shortcut_roundtrip_with_inherited_restricted_policy(self):
        result=subprocess.run([PS,'-NoProfile','-File',str(HERE/'ReleaseSafetyFixture.ps1'),'-Sandbox',str(self.root),'-Case','startup-shortcut-bundle'],capture_output=True,text=True,timeout=45,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_r0_cannot_change_same_version_payload(self):
        self.ps(f""". '{HERE}/BootstrapRepair.ps1'
# Substitute artifact I/O only. Exercise the actual R0 policy, not a copied check.
function Assert-ReleasePlan {{param($Plan,[switch]$ForBootstrap)}}
function Assert-BootstrapSecurityEvidence {{param($Plan,[switch]$ForRecovery)}}
$hash='a'*64;$entry=[pscustomobject]@{{path='resources/bin/orca.exe';size=7;sha256=$hash;requiredNonempty=$true}}
$proofPath='{self.root}/proof.json'
@{{result='PASS_EMBEDDED_CLI_MATCHES_APPROVED_PACKET';installerSha256=$hash;embeddedCliSha256=$hash}}|ConvertTo-Json|Set-Content $proofPath
$plan=[pscustomobject]@{{version='1';rollback=[pscustomobject]@{{version='1';manifest=[pscustomobject]@{{files=@($entry)}}}};candidate=[pscustomobject]@{{files=@(($entry|ConvertTo-Json|ConvertFrom-Json))}};installer=[pscustomobject]@{{sha256=$hash}};bootstrap=[pscustomobject]@{{kind='R0_SAME_VERSION';preRepairVersion='1';initialMissingPaths=@('resources/bin/orca.exe');embeddedCliSha256=$hash;securityEvidence=[pscustomobject]@{{sha256=$hash}};installerProof=[pscustomobject]@{{path=$proofPath;sha256=(Get-ReleaseHash $proofPath)}}}}}}
Assert-BootstrapRepairPlan $plan
$plan.candidate.files[0].size=8
$blocked=$false;try{{Assert-BootstrapRepairPlan $plan}}catch{{$blocked=$true}};if(-not $blocked){{throw 'Same-version payload substitution accepted'}}
""")

if __name__ == '__main__':
    unittest.main()
