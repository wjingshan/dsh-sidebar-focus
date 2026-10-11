#Requires -Version 5.1
<#
  dsh-sidebar-focus 一键发布脚本
  ------------------------------------------------
  功能：提交改动 → 升级版本号（改 package.json + commit + tag）→ 推送 → 创建 GitHub Release

  用法（在仓库任意位置运行均可）：
    .\release.ps1 -Message "fix: 修正 xxx"                  # 默认 patch（0.1.0 → 0.1.1）
    .\release.ps1 -Type minor -Message "feat: 新增 xxx"     # minor（→ 0.2.0）
    .\release.ps1 -Version 0.3.0 -Message "feat: ..."       # 显式版本号
    .\release.ps1 -Message "..." -Notes "发布说明…"          # 自定义 Release 说明
    .\release.ps1 -Message "..." -DryRun                    # 预演，不真正执行

  认证：创建 Release 用**已登录的 gh CLI**（`gh auth login`），不需要另配 PAT。
        没装 gh 时退化为只推送、不建 Release，并明确告诉你怎么做。

  为什么用它而不是手工敲：
    版本记录是回退的凭据。这个脚本保证「package.json 的 version」「git tag」
    「CHANGELOG 的条目」「GitHub Release」四者对齐 —— 手工做时最容易漏掉其中一个，
    等真要回滚了才发现对不上（dsh-wiring-graph 的 v0.1.6 就是这样：tag 与 CHANGELOG
    条目对不上，只能注销那个 tag 的参考价值）。它**不会**替你写 CHANGELOG，
    跑完请确认顶部那条日期与版本号跟这次一致。
#>
[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Type = 'patch',
  [string]$Version = '',
  [string]$Message = '',
  [string]$Notes = '',
  [switch]$DryRun,
  [string]$Owner = 'wjingshan',
  [string]$Repo = 'dsh-sidebar-focus'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Write-Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Fail([string]$m)       { Write-Host "`n[x] $m" -ForegroundColor Red; exit 1 }

# 0) 前置检查
Write-Step '前置检查'
if ((git rev-parse --is-inside-work-tree 2>$null) -ne 'true') { Fail '当前目录不是 git 仓库（先 git init 并配置 remote）' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail '未找到 npm 命令' }
$hasGh = [bool](Get-Command gh -ErrorAction SilentlyContinue)
if (-not $hasGh) { Write-Warn '未找到 gh CLI：会推送，但不会创建 GitHub Release' }
$remote = (git remote get-url origin 2>$null)
if (-not $remote) { Write-Warn '没有 origin remote：推送会失败（先 git remote add origin …）' }
Write-Ok "仓库：$PSScriptRoot"
if ($remote) { Write-Ok "origin：$remote" }

# 1) 提交工作区改动
Write-Step '提交改动'
$dirty = @(git status --porcelain).Count
if ($dirty -gt 0) {
  if (-not $Message) { Fail '工作区有未提交改动，请用 -Message 提供提交说明（如 -Message "fix: 修正 xxx"）' }
  if ($DryRun) {
    Write-Warn "[dry-run] git add -A; git commit -m `"$Message`""
  } else {
    git add -A
    git commit -m $Message | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'git commit 失败' }
    Write-Ok "已提交：$Message"
  }
} else {
  Write-Ok '工作区干净，无需提交'
}

# 2) 记录上一个 tag（用于生成 Release 说明）
$prevTag = git describe --tags --abbrev=0 2>$null
if (-not $prevTag) { $prevTag = '' }

# 3) 升级版本（npm version 会改 package.json、提交并打 tag；不需要 npm 登录）
Write-Step '升级版本'
if ($DryRun) {
  if ($Version) { Write-Warn "[dry-run] npm version $Version" } else { Write-Warn "[dry-run] npm version $Type" }
} else {
  if ($Version) { npm version $Version | Out-Host } else { npm version $Type | Out-Host }
  if ($LASTEXITCODE -ne 0) { Fail 'npm version 失败' }
  Write-Ok '版本已升级并打 tag'
}
$newVersion = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
$newTag = "v$newVersion"
Write-Ok "新版本：$newVersion（tag $newTag）"

# 4) 推送
Write-Step '推送 main 与 tag'
if ($DryRun) {
  Write-Warn '[dry-run] git push; git push --tags'
} else {
  git push
  if ($LASTEXITCODE -ne 0) { Fail 'git push 失败' }
  git push --tags
  if ($LASTEXITCODE -ne 0) { Fail 'git push --tags 失败' }
  Write-Ok '已推送 main 与 tag'
}

# 5) 生成 Release 说明
Write-Step 'Release 说明'
if (-not $Notes) {
  $commits = if ($prevTag) { git log --oneline "$prevTag..$newTag" 2>$null } else { git log --oneline }
  if (-not $commits) { $commits = "发布 $newTag" }
  $Notes = "## $newTag`n`n$($commits -join "`n")"
}
Write-Ok "说明：`n$Notes"

# 6) 创建 GitHub Release
Write-Step '创建 GitHub Release'
if (-not $hasGh) {
  Write-Warn '跳过：没有 gh CLI。装好后补一条即可：'
  Write-Host "    gh release create $newTag --title `"$newTag`" --notes `"...`"" -ForegroundColor DarkGray
  exit 0
}
if ($DryRun) {
  Write-Warn "[dry-run] gh release create $newTag --repo $Owner/$Repo"
  Write-Ok '预演完成（未做任何修改）'
  exit 0
}
$notesFile = Join-Path $env:TEMP "dsh-sidebar-focus-release-$newVersion.md"
[System.IO.File]::WriteAllText($notesFile, $Notes, (New-Object System.Text.UTF8Encoding($false)))
gh release create $newTag --repo "$Owner/$Repo" --title $newTag --notes-file $notesFile | Out-Host
$ghExit = $LASTEXITCODE
Remove-Item $notesFile -ErrorAction SilentlyContinue
if ($ghExit -ne 0) { Fail 'gh release create 失败（检查 gh auth status 与仓库名）' }

Write-Step '完成'
Write-Host ''
Write-Host "  版本 $newTag 已发布" -ForegroundColor Green
Write-Host "  https://github.com/$Owner/$Repo/releases/tag/$newTag" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  记得确认 CHANGELOG.md 顶部那条的版本号与日期和这次一致。' -ForegroundColor Yellow
