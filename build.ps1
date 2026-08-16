# DeepSeek Harness desktop build script
# Works around electron-builder's hardcoded node_modules exclusion:
#   1) --dir builds win-unpacked first
#   2) manually copy the full DSH runtime into resources\dsh
#   3) --prepackaged wraps that directory into the portable exe
$ErrorActionPreference = "Stop"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

Write-Host "== 1/3 building unpacked app =="
node "D:\deepseek\dsh-desktop\node_modules\electron-builder\cli.js" --dir
if ($LASTEXITCODE -ne 0) { throw "electron-builder --dir failed" }

Write-Host "== 2/3 copying DSH runtime =="
$dest = "D:\deepseek\dsh-desktop\dist\win-unpacked\resources\dsh"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item "D:\deepseek\dsh-desktop\resources\dsh" $dest -Recurse -Force
$count = (Get-ChildItem $dest -Recurse -File | Measure-Object).Count
Write-Host "copied $count files"

Write-Host "== 3/3 packing NSIS installer =="
node "D:\deepseek\dsh-desktop\node_modules\electron-builder\cli.js" --win nsis --prepackaged "D:\deepseek\dsh-desktop\dist\win-unpacked"
if ($LASTEXITCODE -ne 0) { throw "electron-builder --win nsis failed" }

$exe = Get-Item "D:\deepseek\dsh-desktop\dist\DeepSeekHarness-Setup.exe"
$mb = [math]::Round($exe.Length/1MB,1)
Write-Host "== DONE: $($exe.FullName) ($mb MB) =="
