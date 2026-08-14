#!/usr/bin/env bash
# install.sh — 一键安装 dsa-zotero-sidebar 到某个 DSH profile。
# 等价于 README 的「手动安装」三步骤，全部幂等，可安全重复执行。
#
# 用法：
#   bash install.sh [profile] [--restart] [--dry-run]
#   profile    目标 DSH profile（默认 web）
#   --restart  装完自动重启 dsh web --profile <profile>
#   --dry-run  只打印将要执行的步骤，不真正执行
#
# curl | bash:
#   curl -fsSL https://raw.githubusercontent.com/yuzh2001/dsh-zotero/main/scripts/install.sh | bash
set -euo pipefail

PROFILE="${1:-web}"
RESTART=false
DRY_RUN=false
for a in "$@"; do
  case "$a" in
    --restart) RESTART=true ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PACKAGE="dsa-zotero-sidebar"

info()  { printf '\033[0;34m[install]\033[0m %s\n' "$*"; }
warn()  { printf '\033[0;33m[install]\033[0m %s\n' "$*" >&2; }
err()   { printf '\033[0;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# dry-run 包装：不真正执行，只回显。
run() {
  if [ "$DRY_RUN" = true ]; then
    printf '\033[0;90m  · %s\033[0m\n' "$*"
  else
    info "▸ $*"
    eval "$@"
  fi
}

# ── 前置检查 ────────────────────────────────────────────────
command -v pnpm >/dev/null 2>&1 || err "找不到 pnpm，请先安装（Node 20+ / pnpm 10+）。"
command -v dsh  >/dev/null 2>&1 || err "找不到 dsh 命令。请确认 DSH 已安装（dsh web 可正常运行）。"
[ -d "$PROFILE_DIR" ] || err "找不到 profile 目录：$PROFILE_DIR（先跑一次 dsh web --profile $PROFILE 让其初始化）。"

info "安装 dsa-zotero-sidebar → profile: $PROFILE"

# ── ① 放行构建脚本（pnpm 11 拦截）──────────────────────────
info "① 放行构建脚本（pnpm approve-builds）"
(
  cd "$PROFILE_DIR"
  run "pnpm approve-builds --all"
)

# ── ② 放行不足 24h 的新版本（一次性）──────────────────────
info "② 戳 pnpm-workspace.yaml 的 minimumReleaseAgeExclude"
(
  cd "$PROFILE_DIR"
  WS="pnpm-workspace.yaml"
  if grep -q 'minimumReleaseAgeExclude' "$WS" 2>/dev/null; then
    if ! grep -q -- "- $PACKAGE" "$WS"; then
      run "printf '%s\\n' '  - $PACKAGE' >> '$WS'"
    else
      info "  已存在 $PACKAGE，跳过"
    fi
  else
    run "printf '%s\\n' 'minimumReleaseAgeExclude:' '  - $PACKAGE' >> '$WS'"
  fi
)

# ── ③ 安装并自动挂载 ──────────────────────────────────────
info "③ dsh plugin --profile $PROFILE add $PACKAGE"
run "dsh plugin --profile '$PROFILE' add '$PACKAGE'"

# ── ④ 清理旧版手动挂载残留，避免双挂载 ─────────────────────
info "④ 清理旧版手动挂载残留"
(
  cd "$PROFILE_DIR"
  PATCH="cordis.patch.yml"
  if [ -f "$PATCH" ] && grep -q 'zotero-sidebar' "$PATCH"; then
    warn "检测到 $PATCH 内含 zotero-sidebar 的旧手动挂载行；为避免双挂载，请手动删除相关 - insert 块后重载。"
  else
    info "  无旧手动挂载残留"
  fi
)

# ── 收尾 ─────────────────────────────────────────────────
if [ "$DRY_RUN" = true ]; then
  info "（--dry-run）以上为将要执行的步骤，未做任何改动。"
  exit 0
fi

info "完成。请硬刷新浏览器（Cmd/Ctrl+Shift+R）。client 改动无需重启 DSH；仅 host 半改动时才需重启。"
if [ "$RESTART" = true ]; then
  info "按 --restart 重启 dsh web --profile $PROFILE …"
  run "dsh web --profile '$PROFILE'"
fi
