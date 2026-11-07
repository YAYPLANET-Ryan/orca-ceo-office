!ifndef ORCA_SCOPED_PROCESS_OPERATIONS
!define ORCA_SCOPED_PROCESS_OPERATIONS

!macroundef FIND_PROCESS
!macro FIND_PROCESS _FILE _RETURN
  nsExec::Exec /TIMEOUT=60000 `"$PowerShellPath" -Command "try { if (-not [IO.Path]::IsPathRooted($$env:ORCA_NSIS_INSTALL_ROOT) -or [IO.Path]::GetPathRoot($$env:ORCA_NSIS_INSTALL_ROOT).Length -lt 3) { exit 2 }; $$root = [IO.Path]::GetFullPath($$env:ORCA_NSIS_INSTALL_ROOT).TrimEnd('\') + '\'; $$volume = [IO.Path]::GetPathRoot($$root).TrimEnd('\') + '\'; if ($$root -eq $$volume) { exit 2 }; if (@(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne $pid -and $$_.ExecutablePath.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { exit 0 } else { exit 1 } } catch { exit 2 }"`
  Pop ${_RETURN}
  ${if} ${_RETURN} != 0
  ${andIf} ${_RETURN} != 1
    SetErrorLevel 2
    Quit
  ${endIf}
!macroend

!macroundef KILL_PROCESS
!macro KILL_PROCESS _FILE _FORCE
  Push $0
  StrCpy $0 ""
  ${if} ${_FORCE} == 1
    StrCpy $0 "-Force"
  ${endIf}
  nsExec::Exec /TIMEOUT=60000 `"$PowerShellPath" -Command "try { if (-not [IO.Path]::IsPathRooted($$env:ORCA_NSIS_INSTALL_ROOT) -or [IO.Path]::GetPathRoot($$env:ORCA_NSIS_INSTALL_ROOT).Length -lt 3) { exit 2 }; $$root = [IO.Path]::GetFullPath($$env:ORCA_NSIS_INSTALL_ROOT).TrimEnd('\') + '\'; $$volume = [IO.Path]::GetPathRoot($$root).TrimEnd('\') + '\'; if ($$root -eq $$volume) { exit 2 }; Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne $pid -and $$_.ExecutablePath.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { try { $$target = Get-Process -Id $$_.ProcessId -ErrorAction Stop; if ($$target.Path -and $$target.Path.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase)) { Stop-Process -InputObject $$target $0 -ErrorAction Stop } } catch { if ($$_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId,*') { throw } } }; exit 0 } catch { exit 2 }"`
  Pop $0
  ${if} $0 != 0
    SetErrorLevel 2
    Quit
  ${endIf}
  Pop $0
!macroend
!endif
