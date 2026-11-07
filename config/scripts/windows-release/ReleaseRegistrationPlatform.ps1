function Get-ReleaseStartupFolder { [Environment]::GetFolderPath('Startup') }
function Get-ReleaseExecutionPolicy {
    Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
    Get-ExecutionPolicy
}
function Initialize-ReleaseScheduler {
    Import-Module "$env:SystemRoot/System32/WindowsPowerShell/v1.0/Modules/ScheduledTasks/ScheduledTasks.psd1" -ErrorAction Stop
}
function New-ReleaseSchedulerPrincipal {
    New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
}
function Get-ReleaseScheduledTaskProjection([string]$Name) {
    try{
        $task=Get-ScheduledTask -TaskName $Name -ErrorAction Stop
        if(@($task.Actions).Count -ne 1){return @{status='UNVERIFIABLE'}}
        @{status='FOUND';execute=$task.Actions[0].Execute;arguments=$task.Actions[0].Arguments}
    }catch{
        if($_.CategoryInfo.Category -eq 'ObjectNotFound'){@{status='MISSING'}}else{@{status='UNVERIFIABLE'}}
    }
}
