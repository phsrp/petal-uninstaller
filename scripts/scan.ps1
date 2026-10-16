# Lists installed programs (registry Uninstall keys) and Store apps as JSON.
param([switch]$Store)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Get-DesktopApps {
  $roots = @(
    @{ Hive = 'HKLM'; Path = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; View = [Microsoft.Win32.RegistryView]::Registry64; Arch = 'x64' },
    @{ Hive = 'HKLM'; Path = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; View = [Microsoft.Win32.RegistryView]::Registry32; Arch = 'x86' },
    @{ Hive = 'HKCU'; Path = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; View = [Microsoft.Win32.RegistryView]::Registry64; Arch = 'user' }
  )
  $seen = @{}
  foreach ($r in $roots) {
    $hive = if ($r.Hive -eq 'HKLM') { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $r.View)
    $key = $base.OpenSubKey($r.Path)
    if (-not $key) { continue }
    foreach ($name in $key.GetSubKeyNames()) {
      $k = $key.OpenSubKey($name)
      if (-not $k) { continue }
      $display = $k.GetValue('DisplayName')
      if (-not $display) { $k.Close(); continue }
      if ($k.GetValue('SystemComponent') -eq 1 -or $k.GetValue('ParentKeyName') -or $k.GetValue('ReleaseType') -match 'Update|Hotfix') { $k.Close(); continue }
      $uninst = $k.GetValue('UninstallString')
      $quiet = $k.GetValue('QuietUninstallString')
      $wow = ($r.View -eq [Microsoft.Win32.RegistryView]::Registry32)
      $regPath = "$($r.Hive)\$(if ($wow) { 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' } else { $r.Path })\$name"
      # 32-bit and 64-bit views can point at the same key on some systems
      if ($seen.ContainsKey($regPath)) { $k.Close(); continue }
      $seen[$regPath] = $true
      $size = $k.GetValue('EstimatedSize')
      [pscustomobject]@{
        id              = $regPath
        kind            = 'desktop'
        name            = "$display".Trim()
        publisher       = "$($k.GetValue('Publisher'))".Trim()
        version         = "$($k.GetValue('DisplayVersion'))"
        installDate     = "$($k.GetValue('InstallDate'))"
        sizeKB          = if ($size) { [int64]$size } else { 0 }
        installLocation = "$($k.GetValue('InstallLocation'))".Trim('"', ' ')
        uninstallString = "$uninst"
        quietUninstall  = "$quiet"
        displayIcon     = "$($k.GetValue('DisplayIcon'))"
        msi             = ($k.GetValue('WindowsInstaller') -eq 1) -or ("$uninst" -match '(?i)msiexec')
        keyName         = $name
        arch            = $r.Arch
        helpLink        = "$($k.GetValue('HelpLink'))"
        urlInfo         = "$($k.GetValue('URLInfoAbout'))"
        noRemove        = ($k.GetValue('NoRemove') -eq 1)
        hasUninstaller  = [bool]$uninst
        modified        = 0
      }
      $k.Close()
    }
    $key.Close()
  }
}

Add-Type -Namespace Win32 -Name Shlw -MemberDefinition '[DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] public static extern int SHLoadIndirectString(string src, System.Text.StringBuilder outBuf, int cch, IntPtr r);'
function Resolve-Res($pkg, $res) {
  if ($res -notmatch '^ms-resource:') { return $res }
  $key = $res.Substring(12)
  $tries = if ($key -match '^//') { @("ms-resource:$key") } elseif ($key -match '/') { @("ms-resource://$($pkg.Name)/$($key.TrimStart('/'))") } else { @("ms-resource://$($pkg.Name)/resources/$key", "ms-resource://$($pkg.Name)/$key") }
  foreach ($t in $tries) {
    $sb = New-Object System.Text.StringBuilder 1024
    if ([Win32.Shlw]::SHLoadIndirectString("@{$($pkg.PackageFullName)? $t}", $sb, 1024, [IntPtr]::Zero) -eq 0 -and $sb.Length) { return $sb.ToString() }
  }
  return $res
}

function Get-StoreApps {
  Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable -and $_.SignatureKind -ne 'System' -and -not $_.IsResourcePackage } | ForEach-Object {
    $p = $_
    $name = $p.Name; $logo = ''; $pub = $p.Publisher
    try {
      $m = [xml](Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml') -Raw -Encoding UTF8)
      $dn = Resolve-Res $p $m.Package.Properties.DisplayName
      if ($dn -and $dn -notmatch '^ms-resource:') { $name = $dn }
      $pd = Resolve-Res $p $m.Package.Properties.PublisherDisplayName
      if ($pd -and $pd -notmatch '^ms-resource:') { $pub = $pd }
      $l = $m.Package.Properties.Logo
      if ($l) {
        $full = Join-Path $p.InstallLocation $l
        $dir = Split-Path $full; $stem = [IO.Path]::GetFileNameWithoutExtension($full); $ext = [IO.Path]::GetExtension($full)
        $hit = Get-ChildItem -LiteralPath $dir -Filter "$stem*$ext" | Sort-Object Length -Descending | Select-Object -First 1
        if ($hit) { $logo = $hit.FullName } elseif (Test-Path -LiteralPath $full) { $logo = $full }
      }
    } catch {}
    if ($name -match '^ms-resource:') { $name = $p.Name }
    $pub = $pub -replace '^CN=([^,]+).*$', '$1'
    [pscustomobject]@{
      id              = $p.PackageFullName
      kind            = 'store'
      name            = "$name"
      publisher       = "$pub"
      version         = "$($p.Version)"
      installDate     = ''
      sizeKB          = 0
      installLocation = "$($p.InstallLocation)"
      packageFamily   = $p.PackageFamilyName
      displayIcon     = $logo
      modified        = 0
      hasUninstaller  = $true
    }
  }
}

$result = if ($Store) { @(Get-StoreApps) } else { @(Get-DesktopApps) }
ConvertTo-Json -InputObject $result -Depth 3 -Compress
