# Один раз после создания пустого репозитория на GitHub: вставь HTTPS-URL репозитория.
# Пример: .\push.ps1 "https://github.com/you/sinc.git"
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Url
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (git remote get-url origin 2>$null) {
  git remote set-url origin $Url
} else {
  git remote add origin $Url
}
git branch -M main
git push -u origin main
