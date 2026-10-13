$ErrorActionPreference = 'Stop'
$taskProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskCache = Join-Path $taskProjectRoot '.qa\builder-cache'
$taskTemporary = Join-Path $taskProjectRoot '.qa\builder-temp'
New-Item -ItemType Directory -Force $taskCache,$taskTemporary | Out-Null
$taskVariables = @('ELECTRON_BUILDER_CACHE','APP_BUILDER_TMP_DIR','TEMP','TMP')
$taskPrevious = @{}
foreach ($taskVariable in $taskVariables) { $taskPrevious[$taskVariable] = [Environment]::GetEnvironmentVariable($taskVariable,'Process') }
$taskWorkingDirectory = Get-Location
try {
  # Keep archive extraction on one physical volume, including when run by MSIX apps.
  [Environment]::SetEnvironmentVariable('ELECTRON_BUILDER_CACHE',$taskCache,'Process')
  [Environment]::SetEnvironmentVariable('APP_BUILDER_TMP_DIR',$taskTemporary,'Process')
  [Environment]::SetEnvironmentVariable('TEMP',$taskTemporary,'Process')
  [Environment]::SetEnvironmentVariable('TMP',$taskTemporary,'Process')
  Set-Location -LiteralPath $taskProjectRoot
  if (-not (Test-Path -LiteralPath 'node_modules\electron\path.txt')) {
    & node 'node_modules\electron\install.js'
    if ($LASTEXITCODE -ne 0) { throw 'Electron运行环境下载失败' }
  }
  & npm run package:win
  if ($LASTEXITCODE -ne 0) { throw 'Windows安装包构建失败' }
} finally {
  Set-Location -LiteralPath $taskWorkingDirectory.Path
  foreach ($taskVariable in $taskVariables) { [Environment]::SetEnvironmentVariable($taskVariable,$taskPrevious[$taskVariable],'Process') }
}
