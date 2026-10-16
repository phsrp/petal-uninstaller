# Does the destructive work for Petal Uninstaller. Reads a job JSON file, writes a result JSON file.
# Job: { killDirs: [dir], items: [{ type: 'folder'|'file'|'key'|'value', path, value? }], recycle: bool, backupDir, resultFile }
# Runs elevated when the app itself is not admin, so stdout is not used for results.
param([Parameter(Mandatory)][string]$JobFile)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName Microsoft.VisualBasic
$results = New-Object System.Collections.ArrayList

# Stop anything running from the folders we are about to delete, so files are not locked.
$killed = 0
foreach ($dir in @($job.killDirs)) {
  if (-not $dir) { continue }
  $d = $dir.TrimEnd('\') + '\'
  Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) -and $_.Id -ne $PID } | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force; $killed++ } catch {}
  }
}
if ($killed) { Start-Sleep -Milliseconds 600 }

function Get-RegPaths($path) {
  # "HKLM\SOFTWARE\X" -> provider path + hive-qualified path for reg.exe
  $p = $path -replace '^HKEY_LOCAL_MACHINE', 'HKLM' -replace '^HKEY_CURRENT_USER', 'HKCU' -replace '^HKEY_CLASSES_ROOT', 'HKCR'
  return @{ Reg = $p; Ps = ($p -replace '^(HKLM|HKCU|HKCR)\\', '$1:\') -replace '^HKCR:', 'Registry::HKEY_CLASSES_ROOT' }
}

$i = 0
foreach ($it in @($job.items)) {
  $i++
  $r = [ordered]@{ path = $it.path; type = $it.type; value = $it.value; ok = $false; error = '' }
  try {
    switch ($it.type) {
      'folder' {
        if (Test-Path -LiteralPath $it.path) {
          if ($job.recycle) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($it.path, 'OnlyErrorDialogs', 'SendToRecycleBin')
          } else {
            Remove-Item -LiteralPath $it.path -Recurse -Force
          }
        }
        $r.ok = -not (Test-Path -LiteralPath $it.path)
        if (-not $r.ok) { $r.error = 'Some files are still in use' }
      }
      'file' {
        if (Test-Path -LiteralPath $it.path) {
          if ($job.recycle) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($it.path, 'OnlyErrorDialogs', 'SendToRecycleBin')
          } else {
            Remove-Item -LiteralPath $it.path -Force
          }
        }
        $r.ok = -not (Test-Path -LiteralPath $it.path)
      }
      'key' {
        $p = Get-RegPaths $it.path
        if (Test-Path -LiteralPath $p.Ps) {
          $bak = Join-Path $job.backupDir ("{0:000}-{1}.reg" -f $i, (($p.Reg -split '\\')[-1] -replace '[^\w\.-]', '_'))
          & reg.exe export $p.Reg $bak /y | Out-Null
          Remove-Item -LiteralPath $p.Ps -Recurse -Force
        }
        $r.ok = -not (Test-Path -LiteralPath $p.Ps)
      }
      'value' {
        $p = Get-RegPaths $it.path
        $bak = Join-Path $job.backupDir ("{0:000}-value.reg" -f $i)
        & reg.exe export $p.Reg $bak /y | Out-Null
        Remove-ItemProperty -LiteralPath $p.Ps -Name $it.value -Force
        $r.ok = $true
      }
    }
  } catch {
    $r.error = $_.Exception.Message
  }
  [void]$results.Add([pscustomobject]$r)
}

[IO.File]::WriteAllText($job.resultFile, (ConvertTo-Json -InputObject @{ killed = $killed; results = @($results) } -Depth 4), (New-Object Text.UTF8Encoding $false))
