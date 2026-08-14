# install.ps1 — 一键安装 dsa-zotero-sidebar 到某个 DSH profile（Windows / PowerShell 5.1+）。
# 等效于 README 的「手动安装」步骤，全部幂等，可安全重复执行。
# 若上游 dsh-better-sidebar 未安装，会先执行它的官方一键安装脚本。
#
# 用法：
#   .\install.ps1 [-Profile web] [-Restart] [-DryRun]
#
# 远程执行：
#   irm https://raw.githubusercontent.com/yuzh2001/dsh-zotero/main/scripts/install.ps1 | iex
#   带参数：& ([scriptblock]::Create((irm '.../install.ps1'))) -Profile ext-dev -Restart

param(
  [string]$Profile = 'web',
  [switch]$Restart,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$HOME\.dsh" }
$ProfileDir = Join-Path $DSH_HOME "profiles\$Profile"
$Package = 'dsa-zotero-sidebar'
# 上游依赖：本插件挂在 dsh-better-sidebar 的右侧栏上；未装则先装它。
$Better   = 'dsh-better-sidebar'
$BetterSource = 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'

function Info($m) { Write-Host "[install] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[install] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[install] $m" -ForegroundColor Red; exit 1 }
function Exec($m) {
  if ($DryRun) { Write-Host "  · $m" -ForegroundColor DarkGray; return }
  Info "▸ $m"
  Invoke-Expression $m
}

# ── 前置检查 ─────────────────────────────────────────────
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Err '找不到 pnpm，请先安装（Node 20+ / pnpm 10+）。' }
if (-not (Get-Command dsh  -ErrorAction SilentlyContinue)) { Err '找不到 dsh 命令。请确认 DSH 已安装（dsh web 可正常运行）。' }
if (-not (Test-Path $ProfileDir)) { Err "找不到 profile 目录：$ProfileDir（先跑一次 dsh web --profile $Profile 让其初始化）。" }

Info "安装 dsa-zotero-sidebar → profile: $Profile"

# ── ① 上游依赖：确认已装 dsh-better-sidebar，未装则先执行官方安装 ─────
Info "① 检查上游依赖 $Better"
Push-Location $ProfileDir
try {
  if (Test-Path "node_modules\$Better") {
    Info '  已安装 dsh-better-sidebar，跳过'
  } else {
    Warn '未检测到 dsh-better-sidebar，先执行其官方一键安装…'
    if ($DryRun) {
      Write-Host "  · irm $BetterSource | iex" -ForegroundColor DarkGray
    } else {
      Info "▸ irm $BetterSource | iex"
      Invoke-Expression "irm '$BetterSource' | iex"
      Warn '请确认上游安装成功后再重跑本脚本（本脚本继续执行以免漏装本插件）。'
    }
  }
} finally { Pop-Location }

# ── ② 放行构建脚本（pnpm 11 拦截，本插件）────────────────
Info '② 放行构建脚本（pnpm approve-builds）'
Push-Location $ProfileDir
try {
  Exec 'pnpm approve-builds --all'
} finally { Pop-Location }

# ── ③ 放行不足 24h 的新版本 ───────────────────────────────
Info '③ 戳 pnpm-workspace.yaml 的 minimumReleaseAgeExclude'
Push-Location $ProfileDir
try {
  $WS = Join-Path $ProfileDir 'pnpm-workspace.yaml'
  if (Test-Path $WS) {
    $content = Get-Content $WS -Raw -ErrorAction SilentlyContinue
    if ($content -match 'minimumReleaseAgeExclude') {
      if ($content -match "- $Package") { Info '  已放行 dsa-zotero-sidebar' }
      else { Exec "Add-Content -Path '$WS' -Value \" - $Package\"" }
    } else {
      Exec "Add-Content -Path '$WS' -Value \"`nminimumReleaseAgeExclude:`n  - $Package\""
    }
  } else {
    Exec "Set-Content -Path '$WS' -Value \"minimumReleaseAgeExclude:`n  - $Package\""
  }
} finally { Pop-Location }

# ── ④ 安装并自动挂载本插件 ────────────────────────────────
Info "④ dsh plugin --profile $Profile add $Package"
Exec "dsh plugin --profile '$Profile' add '$Package'"

# ── ⑤ 清理旧版手动挂载残留 ────────────────────────────────
Info '⑤ 检查旧版手动挂载残留'
Push-Location $ProfileDir
try {
  $PATCH = Join-Path $ProfileDir 'cordis.patch.yml'
  if ((Test-Path $PATCH) -and ((Get-Content $PATCH -Raw) -match 'zotero-sidebar')) {
    Warn '检测到 cordis.patch.yml 内含 zotero-sidebar 的旧手动挂载行；为避免双挂载，请手动删除相关 - insert 块后重载。'
  } else {
    Info '  无旧手动挂载残留'
  }
} finally { Pop-Location }

if ($DryRun) { Info '（-DryRun）以上为将要执行的步骤，未做任何改动。'; exit 0 }

Info '完成。请硬刷新浏览器（Cmd/Ctrl+Shift+R）。client 改动无需重启 DSH；仅 host 半改动时才需重启。'
if ($Restart) {
  Info "按 -Restart 重启 dsh web --profile $Profile …"
  Exec "dsh web --profile '$Profile'"
}
