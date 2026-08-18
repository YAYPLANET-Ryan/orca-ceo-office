# Orca Windows 설치 문제 대응

## 정상 설치 기준

주간 설치기는 `YAYPLANET-Ryan/orca-ceo-office` 릴리스의
`orca-windows-setup.exe.sha256`만 신뢰합니다. 다운로드 파일의 SHA-256이
릴리스 파일과 다르면 설치를 중단하며, Authenticode 서명은 요구하지
않습니다. 설치 전후에도 `%APPDATA%\orca`와 `%USERPROFILE%\.orca`는
수정하지 않습니다.

설치 후 다음을 확인합니다.

```powershell
Get-FileHash "$env:LOCALAPPDATA\orca-updater\verified\<version>\orca-windows-setup.exe" -Algorithm SHA256
Test-Path "$env:LOCALAPPDATA\Programs\orca\resources\app.asar.unpacked\out\main\chunks"
Get-Content "$env:APPDATA\orca\bootstrap-fatal.log" -Tail 30
```

## Bitdefender ATC가 다시 차단할 때

먼저 차단을 해제하거나 실시간 감시를 끄지 말고, 설치를 중단한 뒤
Bitdefender의 알림/격리 메뉴에서 탐지 세부 정보와 파일 목록을 보존합니다.
격리 파일은 다음 위치에서도 확인할 수 있습니다.

```text
C:\ProgramData\Bitdefender\Desktop\Quarantine
```

패키징 수정 후에도 내부 업무용 PC에서 같은 ATC가 반복될 때에만, 해시
검증을 통과한 파일을 내려받는 폴더 하나만 예외로 등록합니다.

1. Bitdefender → 보호(Protection) → 안티바이러스 → 설정(Manage) →
   예외(Manage exceptions)를 엽니다.
2. 다음 폴더만 추가합니다:
   `%LOCALAPPDATA%\orca-updater\verified\`
3. 파일/프로세스 전체 예외, 임시 폴더 전체 예외, 해시 예외는 추가하지
   않습니다.
4. 설치 후 예외를 유지할 필요가 있는지 재검토하고, 신규 격리 항목이
   없는지 확인합니다.

이 절차는 조건부 수동 대응입니다. Bitdefender 전체 끄기, 실시간 감시
해제, `Temp` 전체 예외 등록은 하지 않습니다.

## 자동 롤백

`scripts/orca-weekly-release-install.ps1`은 설치 전
`%LOCALAPPDATA%\Programs\orca`를 `orca-backups`에 보관하고 최신 두 개만
유지합니다. 파일 수·app.asar 버전·90초 기동 로그 검증 중 하나라도
실패하면 이전 설치를 복원합니다. 대화 기록, 모델 연결, 세션 데이터가
있는 APPDATA와 `.orca`는 백업/롤백 대상이 아닙니다.

## 새 PC 등록

`scripts/setup-orca-updater.ps1` 하나만 복사한 뒤 관리자 권한이 필요한
계정에서 다음을 한 번 실행합니다. 인접한 updater 파일이 없으면 이
스크립트가 GitHub CLI 인증을 사용해 비공개 저장소에서 정본을 내려받습니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-orca-updater.ps1
```

예약 작업은 매주 토요일 04:00에 실행되며, 노트북 절전·배터리·놓친 실행을
허용하도록 설정됩니다. GitHub CLI는 기존 Windows 자격 증명 관리자 로그인을
사용하며 토큰을 스크립트에 저장하지 않습니다.

## 향후 외부 배포

현재는 비공개 저장소의 두 대 PC만 대상으로 하므로 코드 서명을 적용하지
않습니다. 외부 배포가 필요해지는 시점에 Authenticode/Trusted Signing을
별도 작업으로 추가합니다.
