; Defining the hook suppresses electron-builder's process-info declarations.
!include "getProcessInfo.nsh"
Var pid
Var /GLOBAL IsPowerShellAvailable
!define ORCA_PROCESS_CHECK_DIR "${__FILEDIR__}"

!macro customCheckAppRunning
  !include "${ORCA_PROCESS_CHECK_DIR}\orca-scoped-process-operations.nsh"
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  StrCpy $pid $0
  ${if} $pid == 0
    SetErrorLevel 2
    Quit
  ${endIf}
  ; A 32-bit PowerShell cannot recheck the executable path of 64-bit targets.
  IfFileExists "$PowerShellPath" 0 +3
  IfFileExists "$WINDIR\SysNative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
  StrCpy $PowerShellPath "$WINDIR\SysNative\WindowsPowerShell\v1.0\powershell.exe"
  System::Call 'kernel32::SetEnvironmentVariable(t "ORCA_NSIS_INSTALL_ROOT", t "$INSTDIR") i.r0'
  ${if} $0 == 0
    SetErrorLevel 2
    Quit
  ${endIf}
  ; Restricted permits inline commands; test the process query rather than script-file policy.
  ; Match upstream FIND/KILL's profile behavior so the probe cannot skip a failing profile.
  nsExec::Exec /TIMEOUT=60000 `"$PowerShellPath" -Command "try { if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { exit 1 }; Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"`
  Pop $0
  ; Image-name fallback could terminate a relocated terminal daemon outside this install.
  ${if} $0 != 0
    DetailPrint "Orca cannot safely identify running app processes. Installation stopped."
    SetErrorLevel 2
    Quit
  ${endIf}
  StrCpy $IsPowerShellAvailable 0
  !insertmacro _CHECK_APP_RUNNING
  System::Call 'kernel32::SetEnvironmentVariable(t "ORCA_NSIS_INSTALL_ROOT", t "")'
!macroend
