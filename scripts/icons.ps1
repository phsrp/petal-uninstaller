# Extracts program icons the way Windows does (respecting "file,index", MSI product icons, .ico/.png files).
# Input: path to a JSON file [{ id, displayIcon, installLocation, uninstallString, msiCode }]. Output: JSON { id: base64 PNG }.
param([Parameter(Mandatory)][string]$InFile)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win32 -Name Ico -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint n, uint flags);
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
'@
$apps = Get-Content -LiteralPath $InFile -Raw -Encoding UTF8 | ConvertFrom-Json
$SIZE = 48

function Split-IconRef($ref) {
  $ref = [Environment]::ExpandEnvironmentVariables("$ref".Trim())
  $idx = 0
  if ($ref -match '^"?(.+?)"?\s*,\s*(-?\d+)$') { $ref = $Matches[1]; $idx = [int]$Matches[2] }
  return @{ Path = $ref.Trim('"', ' '); Index = $idx }
}
function To-Png($bmp) {
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return [Convert]::ToBase64String($ms.ToArray())
}
function Get-Icon($path, $idx) {
  if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  if ($path -match '\.(png|jpe?g|bmp)$') {
    $img = [Drawing.Image]::FromFile($path)
    $bmp = New-Object Drawing.Bitmap $img, $SIZE, $SIZE
    $img.Dispose()
    return To-Png $bmp
  }
  $h = New-Object IntPtr[] 1; $ids = New-Object uint32[] 1
  $n = [Win32.Ico]::PrivateExtractIcons($path, $idx, $SIZE, $SIZE, $h, $ids, 1, 0)
  if ($n -lt 1 -or $h[0] -eq [IntPtr]::Zero) {
    if ($idx -ne 0) { $n = [Win32.Ico]::PrivateExtractIcons($path, 0, $SIZE, $SIZE, $h, $ids, 1, 0) }
    if ($n -lt 1 -or $h[0] -eq [IntPtr]::Zero) { return $null }
  }
  $bmp = [Drawing.Icon]::FromHandle($h[0]).ToBitmap()
  [void][Win32.Ico]::DestroyIcon($h[0])
  return To-Png $bmp
}
function Pack-Guid($g) {
  # MSI stores product codes "packed": each GUID group reversed (pairs swapped in the last two groups)
  $g = $g.Trim('{}') -replace '-', ''
  if ($g.Length -ne 32) { return $null }
  $rev = { param($s) -join ($s.ToCharArray()[($s.Length - 1)..0]) }
  $out = (& $rev $g.Substring(0, 8)) + (& $rev $g.Substring(8, 4)) + (& $rev $g.Substring(12, 4))
  for ($i = 16; $i -lt 32; $i += 2) { $out += $g[$i + 1] + $g[$i] }
  return $out.ToUpper()
}

$result = @{}
foreach ($a in $apps) {
  $cands = New-Object System.Collections.ArrayList
  if ($a.displayIcon) { [void]$cands.Add((Split-IconRef $a.displayIcon)) }
  if ($a.msiCode) {
    $packed = Pack-Guid $a.msiCode
    foreach ($root in "Registry::HKEY_CLASSES_ROOT\Installer\Products\$packed", "HKCU:\Software\Microsoft\Installer\Products\$packed") {
      $pi = (Get-ItemProperty -LiteralPath $root).ProductIcon
      if ($pi) { [void]$cands.Add((Split-IconRef $pi)) }
    }
  }
  if ($a.installLocation -and (Test-Path -LiteralPath $a.installLocation)) {
    $exe = Get-ChildItem -LiteralPath $a.installLocation -Filter *.exe | Where-Object { $_.Name -notmatch 'unins|setup|update|crash|helper|install' } | Sort-Object Length -Descending | Select-Object -First 1
    if ($exe) { [void]$cands.Add(@{ Path = $exe.FullName; Index = 0 }) }
  }
  if ($a.uninstallString -match '^"?([a-zA-Z]:\\[^"]*?\.exe)' -and $Matches[1] -notmatch 'msiexec') { [void]$cands.Add(@{ Path = $Matches[1]; Index = 0 }) }
  # Like Geek Uninstaller: MSI packages without their own icon get the Windows Installer icon
  if ($a.msiCode) { [void]$cands.Add(@{ Path = "$env:SystemRoot\System32\msiexec.exe"; Index = 0 }) }
  foreach ($c in $cands) {
    $png = Get-Icon $c.Path $c.Index
    if ($png) { $result[$a.id] = $png; break }
  }
}
ConvertTo-Json -InputObject $result -Compress
