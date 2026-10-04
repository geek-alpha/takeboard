# Restart the Takeboard server on port 4317.
# Only 4317 is touched. Ports 8188 (video instance) and 8888 (image instance) are never killed here.
$root = 'D:\AI\repos\takeboard'
$port = 4317
New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null

$old = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $old) {
  if ($p) {
    Write-Host "killing old listener pid=$p"
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 600

$out = "$root\logs\server.out.log"
$err = "$root\logs\server.err.log"
Start-Process -FilePath 'npx.cmd' -ArgumentList @('tsx','server/index.ts') -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden

Start-Sleep -Seconds 5
try {
  $health = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 10
  Write-Host "up: root=$($health.root) projects=$($health.projects) comfy8188=$($health.comfy.alive) pid=$($health.pid)"
} catch {
  Write-Host 'failed to start, tail of stderr:'
  Get-Content $err -Tail 20 -ErrorAction SilentlyContinue
}
