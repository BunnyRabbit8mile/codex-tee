# codex-tee watchdog — auto-restarts if killed or crashes
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = "$env:TEMP\codex-tee-watchdog.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  $msg" | Out-File -Append $log
    Write-Host "$ts  $msg"
}

Write-Log "watchdog started | root=$root"

while ($true) {
    Write-Log "starting codex-tee..."
    $proc = Start-Process node -ArgumentList "--use-system-ca","server.js" `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru

    Write-Log "running pid=$($proc.Id)"

    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 5
        # Health check
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:57322/_health" -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -ne 200) { Write-Log "health check failed: $($r.StatusCode)" }
        } catch {
            Write-Log "health check error: $_"
            # If we can't reach it for 3 consecutive tries, kill and restart
            $fails = 0
            for ($i = 0; $i -lt 3; $i++) {
                Start-Sleep -Seconds 3
                try {
                    $r = Invoke-WebRequest -Uri "http://127.0.0.1:57322/_health" -UseBasicParsing -TimeoutSec 3
                    if ($r.StatusCode -eq 200) { $fails = 0; break }
                } catch { $fails++ }
            }
            if ($fails -ge 3) {
                Write-Log "3 consecutive healthcheck fails, killing and restarting"
                if (-not $proc.HasExited) { $proc.Kill() }
                break
            }
        }
    }

    $code = $proc.ExitCode
    Write-Log "process exited code=$code, restarting in 3s..."
    Start-Sleep -Seconds 3
}
