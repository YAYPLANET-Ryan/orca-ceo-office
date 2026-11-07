; electron-builder's default nonzero-result MessageBox has no silent default.
; Silent upgrades must return failure to the durable recovery helper, not wait for UI.
!macro ORCA_VALIDATE_UNINSTALL_RESULT
  ${if} ${Errors}
    DetailPrint "Orca could not launch the previous uninstaller. Installation stopped."
    SetErrorLevel 2
    Quit
  ${endIf}
  ${if} $R0 != 0
    DetailPrint "Orca previous uninstaller failed with code $R0. Installation stopped."
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    ${endIf}
    SetErrorLevel 2
    Quit
  ${endIf}
!macroend

!macro customUnInstallCheck
  !insertmacro ORCA_VALIDATE_UNINSTALL_RESULT
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro ORCA_VALIDATE_UNINSTALL_RESULT
!macroend
