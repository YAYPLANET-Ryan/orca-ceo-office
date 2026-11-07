$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true'){throw 'Disposable GitHub runner only'}
$root=[IO.Path]::GetFullPath($env:ORCA_PROBE_INSTALL).TrimEnd('\')+'\'
$temporary=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if(!$root.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or $root -eq $temporary){throw 'Outside owned temporary installation'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrcaDeleteSharingProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  // DELETE access tests rename sharing, but no deletion, rename or delete-on-close is requested.
  public static int Observe(string name) {
    IntPtr h=CreateFile(name,0x10000,7,IntPtr.Zero,3,0,IntPtr.Zero);
    if(h==new IntPtr(-1))return Marshal.GetLastWin32Error();
    CloseHandle(h);return 0;
  }
}
'@
$scanErrors=@()
$files=@(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable scanErrors | ForEach-Object FullName)
$longest='resources\node_modules\@vscode\windows-process-tree\build\node_modules\node-addon-api\Release\obj\node_addon_api_except\node_add.A031F06B.tlog\node_addon_api_except.lastbuildstate'
$files=@($files+($root+$longest) | Select-Object -Unique)
$failures=@();$count=0
foreach($file in $files){
    if(!$file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){continue}
    $errorCode=[OrcaDeleteSharingProbe]::Observe($file)
    $count++
    if($errorCode -ne 0 -and $failures.Count -lt 24){
        $extendedError=[OrcaDeleteSharingProbe]::Observe('\\?\'+$file)
        $failures+=[ordered]@{relative=$file.Substring($root.Length);pathChars=$file.Length;win32Error=$errorCode;extendedPathError=$extendedError}
    }
}
[ordered]@{scope='POST_FAILURE_HANDLE_OPEN_ONLY_NO_DELETE_OR_RENAME';examined=$count;scanErrorCount=$scanErrors.Count;failures=$failures;incomplete=($failures.Count -ge 24)} | ConvertTo-Json -Depth 5 -Compress
