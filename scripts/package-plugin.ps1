$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageRoot = Join-Path $projectRoot ('.tmp/package-' + [Guid]::NewGuid().ToString('N'))
$stageRoot = Join-Path $packageRoot 'BBPresets'
$outputRoot = Join-Path $projectRoot 'dist'
$outputFile = Join-Path $outputRoot 'BBPresets-v0.3.0-preview.zip'
if (Test-Path -LiteralPath $outputFile) { throw "Package already exists: $outputFile. Preserve it or choose a new version before rebuilding." }
foreach ($targetPath in @($packageRoot, $stageRoot, $outputRoot, $outputFile)) {
    if (-not [IO.Path]::GetFullPath($targetPath).StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escaped the project.' }
}
New-Item -ItemType Directory -Path $stageRoot, $outputRoot -Force | Out-Null
foreach ($fileName in @('manifest.json','index.js','style.css','INSTALL.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot $fileName) -Destination $stageRoot }
foreach ($dirName in @('core','runtime','ui')) { Copy-Item -LiteralPath (Join-Path $projectRoot $dirName) -Destination $stageRoot -Recurse }
Compress-Archive -LiteralPath $stageRoot -DestinationPath $outputFile
$digest = (Get-FileHash -LiteralPath $outputFile -Algorithm SHA256).Hash
Set-Content -LiteralPath ($outputFile + '.sha256') -Value ($digest + '  ' + [IO.Path]::GetFileName($outputFile)) -Encoding utf8
Write-Output $outputFile
Write-Output ('SHA256 ' + $digest)
