; Clean up the relocated terminal daemon on a REAL uninstall.
;
; Why: the daemon host is deliberately copied to a distinct image name
; (orca-terminal-daemon.exe) under %LOCALAPPDATA%\Orca\daemon-host so that app
; UPDATES cannot kill it — that relocation is what keeps terminals alive across
; updates. The same design means a normal uninstall's process sweep and file
; removal both miss it, leaving an orphaned daemon plus its runtime copy behind.
;
; The ${isUpdated} guard is essential: electron-builder runs this uninstaller as
; part of uninstallOldVersion on EVERY update, and killing the daemon there would
; defeat the whole feature. Only clean up on a genuine uninstall.
;
; The image name and the LOCALAPPDATA folder name must stay in sync with
; DAEMON_HOST_EXE_NAME and LOCAL_HOST_ROOT_NAME in
; src/main/daemon/daemon-host-relocation.ts.

; electron-builder's default running-app check uses Stop-Process when
; PowerShell is available and escalates to a forced kill. Either path can skip
; Orca's renderer checkpoint and strand tabs without their agent session.
; Require a normal app quit instead; the user can retry in the same installer.
!macro customCheckAppRunning
  !define ORCA_RUNNING_CHECK_ID ${__LINE__}

  orca_running_check_${ORCA_RUNNING_CHECK_ID}:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${if} ${Silent}
        SetErrorLevel 2
        Quit
      ${else}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
          "Orca is still running. Close Orca normally to save terminal conversations and agent sessions, then click Retry. The installer will not force-close Orca." \
          IDRETRY orca_running_check_${ORCA_RUNNING_CHECK_ID} IDCANCEL orca_running_cancel_${ORCA_RUNNING_CHECK_ID}
      ${endIf}
    ${endIf}
    Goto orca_running_done_${ORCA_RUNNING_CHECK_ID}

  orca_running_cancel_${ORCA_RUNNING_CHECK_ID}:
    SetErrorLevel 2
    Quit

  orca_running_done_${ORCA_RUNNING_CHECK_ID}:
    !undef ORCA_RUNNING_CHECK_ID
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'taskkill /F /IM orca-terminal-daemon.exe'
    ; Give the OS a moment to release the image lock before removing the tree.
    Sleep 500
    RMDir /r "$LOCALAPPDATA\Orca\daemon-host"
  ${endIf}
!macroend
