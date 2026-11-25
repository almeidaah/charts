# Builds the portable folder (charts.exe + Node + files), setup.exe and the portable zip.
#
#   powershell -ExecutionPolicy Bypass -File launcher\build.ps1 [-Output dist\Charts] [-Port 5180]
#
# Needs only Windows and Node 24+. The C# compiler ships with Windows (.NET Framework 4.x).
# The "data" folder inside the output, if any, is never touched or packaged.
param([string]$Output, [int]$Port = 5180, [switch]$NoZip)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
if (-not $Output) { $Output = "$root\dist\Charts" }
$utf8 = New-Object Text.UTF8Encoding($false)
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$node = (Get-Command node).Source
$files = 'server', 'public', 'runtime', 'package.json', 'README.txt', 'charts.exe'

New-Item -ItemType Directory -Force $Output, "$Output\runtime" | Out-Null
$Output = (Resolve-Path $Output).Path
foreach ($d in 'server', 'public') {
  if (Test-Path "$Output\$d") { Remove-Item "$Output\$d" -Recurse -Force -Confirm:$false }
  Copy-Item "$root\$d" $Output -Recurse
}
Copy-Item "$root\package.json" $Output -Force
Copy-Item "$root\launcher\README.txt" $Output -Force
Copy-Item $node "$Output\runtime\node.exe" -Force

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('charts-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
try {
  # The port only changes in tests.
  foreach ($f in 'Launcher.cs', 'Setup.cs') {
    [IO.File]::WriteAllText("$tmp\$f", [IO.File]::ReadAllText("$root\launcher\$f").Replace('5180', "$Port"), $utf8)
  }
  if ($Port -ne 5180) { $j = "$Output\server\index.js"; [IO.File]::WriteAllText($j, [IO.File]::ReadAllText($j).Replace('5180', "$Port"), $utf8) }
  $common = '/nologo', '/codepage:65001', '/target:winexe', '/optimize+', "/win32icon:$root\launcher\icon.ico", '/reference:System.Windows.Forms.dll'
  & $csc $common "/out:$Output\charts.exe" "$tmp\Launcher.cs"
  if ($LASTEXITCODE) { throw 'Could not compile charts.exe' }

  # Package: everything except user data and setup itself.
  $pack = "$tmp\Charts"
  New-Item -ItemType Directory $pack | Out-Null
  foreach ($x in $files) { Copy-Item "$Output\$x" $pack -Recurse }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($pack, "$tmp\payload.zip", 'Optimal', $false)
  & $csc $common '/reference:System.Drawing.dll' '/reference:System.IO.Compression.dll' "/resource:$tmp\payload.zip,payload.zip" "/out:$Output\setup.exe" "$tmp\Setup.cs"
  if ($LASTEXITCODE) { throw 'Could not compile setup.exe' }
  if (-not $NoZip) {
    $zip = Join-Path (Split-Path $Output) 'Charts-portable.zip'
    if (Test-Path $zip) { Remove-Item $zip -Force -Confirm:$false }
    [IO.Compression.ZipFile]::CreateFromDirectory($pack, $zip, 'Optimal', $true)
  }
} finally { Remove-Item $tmp -Recurse -Force -Confirm:$false }
Get-ChildItem $Output | ForEach-Object { '{0,-14} {1}' -f $_.Name, $(if ($_.PSIsContainer) { 'folder' } else { '{0:N1} MB' -f ($_.Length / 1MB) }) }
