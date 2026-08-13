$f = 'C:\Users\drugg\.local\share\opencode\log\dev.log'
$lines = Get-Content $f
Write-Output "TOTAL LINES: $($lines.Count)"
Write-Output ''
Write-Output '=== All doGenerate:in diag headers ==='
$lines | Select-String -Pattern 'CDP_COMPACT_DIAG \[doGenerate:in\] promptLen=' | ForEach-Object { $_.Line }
Write-Output ''
Write-Output '=== compaction / pin lines ==='
$lines | Select-String -Pattern 'agent=compaction','pinning bound tab','summarizer instruction' | ForEach-Object { $_.Line }
Write-Output ''
Write-Output '=== Last 40 lines of the log ==='
$startIdx = :Max(0, $lines.Count - 40)
$lines[$startIdx..($lines.Count - 1)]
