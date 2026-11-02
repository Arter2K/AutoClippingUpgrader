param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Task,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$TaskArgs
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $bundledNode)) { throw 'Node.js 22.12+ is required. Install Node.js with npm.' }
    $nodeCommand = Get-Item -LiteralPath $bundledNode
    $nodeExecutable = $nodeCommand.FullName
} else { $nodeExecutable = $nodeCommand.Source }
$nodeFolder = Split-Path -Parent $nodeExecutable
$env:PATH = $nodeFolder + [IO.Path]::PathSeparator + $env:PATH

# Use the local verification tools when present; explicit configuration takes priority.
$ffmpegFile = Get-ChildItem -Path (Join-Path $PWD '.tools\ffmpeg-*\bin\ffmpeg.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $env:FFMPEG_PATH -and $ffmpegFile) { $env:FFMPEG_PATH = $ffmpegFile.FullName }
$ffprobeFile = Get-ChildItem -Path (Join-Path $PWD '.tools\ffmpeg-*\bin\ffprobe.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $env:FFPROBE_PATH -and $ffprobeFile) { $env:FFPROBE_PATH = $ffprobeFile.FullName }

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCommand) {
    & $npmCommand.Source run $Task -- @TaskArgs
} else {
    $pnpmFile = Join-Path $nodeFolder '..\node_modules\pnpm\bin\pnpm.cjs'
    if (-not (Test-Path -LiteralPath $pnpmFile)) { throw 'Install npm or pnpm to run project scripts.' }
    & $nodeExecutable $pnpmFile run $Task @TaskArgs
}
exit $LASTEXITCODE
