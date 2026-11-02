<#
  Keep the dashboard server running so history is recorded whenever this PC is on (and the PLC is reachable).
  The browser page is not needed for logging - the server reads the PLC and writes the historian.

    powershell -ExecutionPolicy Bypass -File tools\autostart.ps1              # start at logon of this user (no admin)
    powershell -ExecutionPolicy Bypass -File tools\autostart.ps1 -AtBoot      # start at PC boot as SYSTEM (run as administrator; site PC)
    powershell -ExecutionPolicy Bypass -File tools\autostart.ps1 -Remove      # remove the auto-start

  The task runs pythonw (no window), restarts the server every minute if it stops, and never times out.
#>
param([int]$Port = 8082, [switch]$AtBoot, [switch]$Remove, [string]$TaskName = "Ankur Dashboard Server")

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    "Removed scheduled task '$TaskName'."
    return
}

$backend = Split-Path $PSScriptRoot -Parent
$py = (& python -c "import sys;print(sys.executable)").Trim()
$pyw = Join-Path (Split-Path $py) "pythonw.exe"
if (-not (Test-Path $pyw)) { throw "pythonw.exe not found next to $py" }

$action = New-ScheduledTaskAction -Execute $pyw -Argument "run.py --port $Port" -WorkingDirectory $backend
if ($AtBoot) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 9999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "Medge Controls dashboard server (port $Port): reads the PLC and records history. Removes with tools\autostart.ps1 -Remove." -Force | Out-Null
"Registered '$TaskName' ($(if ($AtBoot) { 'at boot, SYSTEM' } else { "at logon of $env:USERNAME" })): $pyw run.py --port $Port in $backend"
