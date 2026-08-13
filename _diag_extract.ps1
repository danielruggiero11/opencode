$f = 'C:\Users\drugg\.local\share\opencode\log\dev.log'
$lines = Get-Content $f
$blocks = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match 'CDP_COMPACT_DIAG \[doGenerate:in\] promptLen=') {
    $start = $i
    $end = $i
    for ($j = $i; $j -lt $lines.Count; $j++) {
      if ($lines[$j] -match '/CDP_COMPACT_DIAG') { $end = $j; break }
    }
    $blocks += ,@($start, $end)
  }
}
Write-Output "FOUND $($blocks.Count) diag blocks"
Write-Output '=================== LAST BLOCK (post-compaction build turn) ==================='
$last = $blocks[$blocks.Count - 1]
$lines[$last[0]..$last[1]]
Write-Output ''
Write-Output '=================== SECOND-TO-LAST BLOCK (the /compact turn itself) ==================='
if ($blocks.Count -ge 2) {
  $prev = $blocks[$blocks.Count - 2]
  $lines[$prev[0]..$prev[1]]
}
