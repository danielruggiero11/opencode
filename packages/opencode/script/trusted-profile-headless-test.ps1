# ============================================================================
# trusted-profile-headless-test.ps1
#
# PURPOSE: Answer the make-or-break question: if we start headless Chrome on a
# COPY of your TRUSTED real Chrome profile, do we land in M365 Copilot with NO
# login -- and does it SURVIVE a close-and-reopen?
#
# It never touches your real profile (read-only copy). It runs entirely on its
# own -- no need for the assistant to be connected.
#
# HOW IT DECIDES: after navigating headless to m365.cloud.microsoft/chat, it
# reads the tab URL from Chrome's /json endpoint.
#   - URL stays on m365.cloud.microsoft  -> AUTHENTICATED (you are in)
#   - URL redirects to login.microsoftonline.com -> REAUTH REQUIRED
#
# USAGE:
#   1. FULLY CLOSE Chrome (all windows + system tray Exit). This disconnects
#      the assistant -- that is expected.
#   2. Run this in PowerShell:
#        powershell -ExecutionPolicy Bypass -File `
#          C:\Users\drugg\Documents\GitHub\opencode\packages\opencode\script\trusted-profile-headless-test.ps1
#   3. Reopen Chrome, reconnect to the assistant, paste the ===VERDICT=== block.
# ============================================================================

$ErrorActionPreference = 'Stop'
$port = 9337
$src  = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$dst  = Join-Path $env:APPDATA 'opencode\cdp-web-profile-REALTEST'
$chatUrl = 'https://m365.cloud.microsoft/chat'

function Write-Head($t) { Write-Host ''; Write-Host ('== ' + $t + ' ==') }

# --- Guard: Chrome must be fully closed (shared process tree locks the DB) ---
$running = Get-Process chrome -ErrorAction SilentlyContinue
if ($running) {
  Write-Host 'ERROR: Chrome is still running (' $running.Count ' processes).'
  Write-Host 'Fully quit Chrome (all windows + tray Exit), then re-run.'
  exit 1
}

# --- Locate chrome.exe ---
$chrome = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Host 'ERROR: chrome.exe not found'; exit 1 }
Write-Host ('chrome: ' + $chrome)

# --- Copy ONLY auth-relevant files from the real profile (read-only) ---
Write-Head 'Copying trusted profile (read-only)'
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Force -Path (Join-Path $dst 'Default\Network') | Out-Null
Copy-Item (Join-Path $src 'Local State') (Join-Path $dst 'Local State') -Force
foreach ($rel in @('Default\Network\Cookies','Default\Cookies','Default\Login Data','Default\Preferences')) {
  $s = Join-Path $src $rel
  if (Test-Path $s) { Copy-Item $s (Join-Path $dst $rel) -Force -ErrorAction SilentlyContinue }
}
Write-Host ('copied to: ' + $dst)
Write-Host ('Local State: ' + (Test-Path (Join-Path $dst 'Local State')) + ' | Cookies: ' + (Test-Path (Join-Path $dst 'Default\Network\Cookies')))

function Start-HeadlessAndProbe($label) {
  Write-Head $label
  $args = @(
    ('--remote-debugging-port=' + $port),
    ('--user-data-dir=' + $dst),
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    $chatUrl
  )
  $proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru
  Start-Sleep -Seconds 3
  # Wait up to 25s for redirects to settle, polling the tab URL.
  $finalUrl = ''
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    try {
      $tabs = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/json') -TimeoutSec 5
      $page = $tabs | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
      if ($page) { $finalUrl = $page.url }
    } catch { }
    # Once it is clearly on chat or clearly on login, stop early.
    if ($finalUrl -match 'm365.cloud.microsoft' -and $finalUrl -notmatch 'login') { break }
    if ($finalUrl -match 'login.microsoftonline.com') { break }
  }
  Write-Host ('final tab URL: ' + $finalUrl)
  # Graceful close via CDP, then hard stop as backstop.
  try {
    $ver = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/json/version') -TimeoutSec 5
  } catch { }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $chrome } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  if ($finalUrl -match 'login.microsoftonline.com') { return 'REAUTH' }
  if ($finalUrl -match 'm365.cloud.microsoft') { return 'AUTHED' }
  return 'UNKNOWN'
}

# Round 1: does the copied trusted profile authenticate headless at all?
$r1 = Start-HeadlessAndProbe 'ROUND 1: headless on fresh copy of trusted profile'

# Round 2: relaunch headless on the SAME copy -- does auth survive a close?
$r2 = Start-HeadlessAndProbe 'ROUND 2: relaunch headless on same profile (survives close?)'

Write-Host ''
Write-Host '===VERDICT==='
Write-Host ('Round 1 (initial headless):   ' + $r1)
Write-Host ('Round 2 (after close/reopen): ' + $r2)
Write-Host ''
if ($r1 -eq 'AUTHED' -and $r2 -eq 'AUTHED') {
  Write-Host 'RESULT: Trusted profile WORKS headless AND survives close. Headless is viable.'
} elseif ($r1 -eq 'AUTHED' -and $r2 -eq 'REAUTH') {
  Write-Host 'RESULT: Authed initially but LOST it on reopen. Trust does not survive a close.'
} elseif ($r1 -eq 'REAUTH') {
  Write-Host 'RESULT: Even the trusted-profile copy demanded login headless. Copied trust does not carry.'
} else {
  Write-Host 'RESULT: Inconclusive (see URLs above).'
}
Write-Host '============='
