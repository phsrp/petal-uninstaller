# Finds registry leftovers for a program. Input: base64 JSON { names: [normalised], publishers: [normalised], dirs: [folder], exes: [exe name] }
param([Parameter(Mandatory)][string]$Query)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Query)) | ConvertFrom-Json
$names = @($q.names); $pubs = @($q.publishers); $dirs = @($q.dirs | Where-Object { $_ }); $exes = @($q.exes | ForEach-Object { "$_".ToLower() })
function Norm($s) { ("$s".ToLower() -replace '[^\p{L}\p{N}]', '') }
$out = New-Object System.Collections.ArrayList
function Add($type, $path, $conf, $why, $value) { [void]$out.Add([pscustomobject]@{ type = $type; path = $path; value = $value; confidence = $conf; why = $why }) }

$softRoots = @(
  @{ Ps = 'HKCU:\Software'; Reg = 'HKCU\Software' },
  @{ Ps = 'HKLM:\SOFTWARE'; Reg = 'HKLM\SOFTWARE' },
  @{ Ps = 'HKLM:\SOFTWARE\WOW6432Node'; Reg = 'HKLM\SOFTWARE\WOW6432Node' }
)
foreach ($root in $softRoots) {
  foreach ($k in Get-ChildItem -LiteralPath $root.Ps) {
    $n = Norm $k.PSChildName
    if (-not $n) { continue }
    if ($names -contains $n) { Add 'key' "$($root.Reg)\$($k.PSChildName)" 'high' 'Settings key named after the app' }
    elseif ($pubs -contains $n) {
      # Publisher key: look one level down for the app
      $subs = @(Get-ChildItem -LiteralPath $k.PSPath)
      foreach ($s in $subs) {
        if ($names -contains (Norm $s.PSChildName)) { Add 'key' "$($root.Reg)\$($k.PSChildName)\$($s.PSChildName)" 'high' 'Settings key under the publisher' }
      }
      if ($subs.Count -le 1 -and ($subs.Count -eq 0 -or $names -contains (Norm $subs[0].PSChildName))) {
        Add 'key' "$($root.Reg)\$($k.PSChildName)" 'low' 'Publisher key with nothing else in it'
      }
    }
  }
}

# App Paths entries for the program's exes
foreach ($ap in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
  foreach ($k in Get-ChildItem -LiteralPath $ap) {
    $def = "$((Get-ItemProperty -LiteralPath $k.PSPath).'(default)')".Trim('"')
    $hit = $exes -contains $k.PSChildName.ToLower()
    foreach ($d in $dirs) { if ($def -and $def.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true } }
    if ($hit) { Add 'key' (($k.Name -replace '^HKEY_LOCAL_MACHINE', 'HKLM') -replace '^HKEY_CURRENT_USER', 'HKCU') 'high' 'App Paths entry' }
  }
}

# Startup entries that point into the install folder
foreach ($run in @('HKCU\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')) {
  $ps = $run -replace '^(HKLM|HKCU)\\', '$1:\'
  $props = Get-ItemProperty -LiteralPath $ps
  if (-not $props) { continue }
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -like 'PS*') { continue }
    $hit = $names -contains (Norm $p.Name)
    foreach ($d in $dirs) { if ("$($p.Value)" -like "*$d*") { $hit = $true } }
    if ($hit) { Add 'value' $run 'high' 'Starts with Windows' $p.Name }
  }
}

ConvertTo-Json -InputObject @($out) -Compress
