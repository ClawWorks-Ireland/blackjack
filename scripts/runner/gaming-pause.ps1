<#
  Gaming pause for the local-llm runner (spec REQ-CFG-4d).
  While any listed game process runs, stop the `local-llm` runner service in WSL so
  the GPU is the game's; start it again when no game is running. Queued slices wait
  (they never fall back to Claude). The claude-jobs runner is never touched.

  Install (Delmar, elevated PowerShell): see .agents/SETUP_REPORT.md, "Checklist for Delmar".
  $Games lists the installed games' process names (without .exe); add any new game there.
#>
param(
  # Process names (no .exe) of the games installed on the PC, found 2026-11-15. Add new games here.
  [string[]]$Games = @(
    'AC2-Win64-Shipping',          # Assetto Corsa Competizione (Steam)
    'AssettoCorsaEVO',             # Assetto Corsa EVO (Steam)
    'acr',                         # Assetto Corsa Rally (Steam)
    'AMS2', 'AMS2AVX',             # Automobilista 2 (Steam)
    'F1_25', 'F1_25_Trial',        # F1 25 (EA)
    'forzahorizon6'                # Forza Horizon 6 (Xbox app)
  ),
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
