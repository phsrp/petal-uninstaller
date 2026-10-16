# Creates two harmless fake programs (current user only) for the end-to-end self-test.
$ErrorActionPreference = 'Stop'
$u = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
foreach ($n in 'PetalTestApp', 'PetalBrokenApp') {
  $dir = Join-Path $env:LOCALAPPDATA "Programs\$n"
  New-Item -ItemType Directory -Force $dir | Out-Null
  Set-Content -LiteralPath (Join-Path $dir 'readme.txt') -Value ('test ' * 2000)
  New-Item -ItemType Directory -Force (Join-Path $env:APPDATA $n) | Out-Null
  Set-Content -LiteralPath (Join-Path $env:APPDATA "$n\settings.ini") -Value 'x=1'
  New-Item -Force "HKCU:\Software\$n" | Out-Null
  Set-ItemProperty "HKCU:\Software\$n" -Name Theme -Value 'rose'
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$n.lnk"))
  $lnk.TargetPath = Join-Path $dir 'readme.txt'; $lnk.Save()
  $k = New-Item -Force "$u\$n"
  Set-ItemProperty $k.PSPath -Name DisplayName -Value ($(if ($n -eq 'PetalTestApp') { 'Petal Test App 1.0' } else { 'Petal Broken App' }))
  Set-ItemProperty $k.PSPath -Name Publisher -Value 'Petal Testing'
  Set-ItemProperty $k.PSPath -Name DisplayVersion -Value '1.0.0'
  Set-ItemProperty $k.PSPath -Name InstallLocation -Value $dir
  Set-ItemProperty $k.PSPath -Name EstimatedSize -Value 12 -Type DWord
  if ($n -eq 'PetalTestApp') {
    Set-ItemProperty $k.PSPath -Name UninstallString -Value "`"$env:SystemRoot\System32\cmd.exe`" /c reg delete `"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\PetalTestApp`" /f"
  }
}
'made'
