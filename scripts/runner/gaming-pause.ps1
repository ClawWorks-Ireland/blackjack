<#
  Gaming pause for the local-llm runner (spec REQ-CFG-4d).
  While any listed game process runs, stop the `local-llm` runner service in WSL so
  the GPU is the game's; start it again when no game is running. Queued slices wait
  (they never fall back to Claude). The claude-jobs runner is never touched.

  Install (Delmar, elevated PowerShell): see .agents/SETUP_REPORT.md, "Checklist for Delmar".
  Edit $Games to match the games you play (process names without .exe).
#>
param(
  [string[]]$Games = @('steam_game_placeholder'),   # e.g. 'eldenring','cs2','FortniteClient-Win64-Shipping','RocketLeague'
  [int]$PollSeconds = 30,
  [string]$Service = 'actions.runner.ClawWorks-Ireland-blackjack.gamingpc-local-llm.service',
  [string]$Log = 'C:\Windows\Temp\gaming-pause.log'
)
$paused = $false
function Say($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 $Log }
Say "gaming-pause started; watching: $($Games -join ', ')"
while ($true) {
  $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $Games -contains $_.ProcessName } | Select-Object -First 1
  if ($running -and -not $paused) {
    & wsl.exe -d Ubuntu -u root -- systemctl stop $Service
    $paused = $true; Say "paused local-llm runner ($($running.ProcessName) running)"
  } elseif (-not $running -and $paused) {
    & wsl.exe -d Ubuntu -u root -- systemctl start $Service
    $paused = $false; Say "resumed local-llm runner"
  }
  Start-Sleep -Seconds $PollSeconds
}
