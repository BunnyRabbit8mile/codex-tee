# codex-tee watchdog — auto-restarts if killed or crashes
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = "$env:TEMP\codex-tee-watchdog.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  $msg" | Out-File -Append $log
}

Write-Log "watchdog started | root=$root"

# Env vars for sinks
$env:LANGFUSE_PUBLIC_KEY = "pk-lf-2519cd87-652e-4d00-bd81-6c9b0cfb698b"
$env:LANGFUSE_SECRET_KEY = "sk-lf-2c3de659-a9b8-49a6-b94b-37b4452a187a"
$env:LANGFUSE_HOST = "https://cloud.langfuse.com"
$env:LANGFUSE_PROJECT = "codex-tee"
$env:LANGFUSE_MAX_EVENT_SIZE_BYTES = "10000000"
# $env:HTTPS_PROXY = "http://127.0.0.1:7897"

while ($true) {
    Write-Log "starting codex-tee..."
    $proc = Start-Process node -ArgumentList "--use-system-ca","server.js" `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru

    Write-Log "running pid=$($proc.Id)"

    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 5
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:57322/_health" -UseBasicParsing -TimeoutSec 3
        } catch {
            $fails = 0
            for ($i = 0; $i -lt 3; $i++) {
                Start-Sleep -Seconds 3
                try {
                    $r = Invoke-WebRequest -Uri "http://127.0.0.1:57322/_health" -UseBasicParsing -TimeoutSec 3
                    if ($r.StatusCode -eq 200) { $fails = 0; break }
                } catch { $fails++ }
            }
            if ($fails -ge 3) {
                Write-Log "3 fails, restarting"
                if (-not $proc.HasExited) { $proc.Kill() }
                break
            }
        }
    }

    $code = $proc.ExitCode
    Write-Log "exited code=$code, restarting in 3s..."
    Start-Sleep -Seconds 3
}



