; Defining the hook suppresses electron-builder's process-info declarations.
!include "getProcessInfo.nsh"
Var pid
Var /GLOBAL IsPowerShellAvailable

!macro customCheckAppRunning
  ; Restricted permits inline commands; test the process query rather than script-file policy.
  ; Match upstream FIND/KILL's profile behavior so the probe cannot skip a failing profile.
  nsExec::Exec /TIMEOUT=60000 `"$PowerShellPath" -Command "try { Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"`
  Pop $0
  ; Image-name fallback could terminate a relocated terminal daemon outside this install.
  ${if} $0 != 0
    DetailPrint "Orca cannot safely identify running app processes. Installation stopped."
    SetErrorLevel 2
    Quit
  ${endIf}
  StrCpy $IsPowerShellAvailable 0
  !insertmacro _CHECK_APP_RUNNING
!macroend
