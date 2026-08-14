# dsa-zotero-sidebar

<!-- 头部介绍区 -->
<div align="center">
  <b style="font-size: 1.15em;">在 DeepSeek Harness 里直接浏览、引用你的 Zotero 文献库</b><br /><br />
  <code>Zotero 文件树</code> <code>双击引用</code> <code>内联搜索</code> <code>/zotero 命令</code> <code>模型工具</code><br /><br />
  <b>右侧边栏 + 输入框快捷引用</b>，边读论文边写 prompt。<br />
  <small>基于 dsh-better-sidebar 的右侧栏，宿主侧直接读 Zotero SQLite</small>
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a>
</div>

## ✨ 功能一览

- **🗂️ Zotero 文件树**：在 better-sidebar 右侧栏渲染你的 Zotero 文库（收藏夹层级、懒加载展开），宿主直接读本地 `zotero.sqlite`，无需 API key
- **🖱️ 双击引用**：双击任意论文/文件夹 → 在输入框注入可读引用 `《论文题名》{%ZoteroItem:key%}`，光标零破坏（纯文本，不用 DSH chip 占位）
- **🔎 `&` 内联搜索**：在输入框打 `&` 弹出自绘搜索层（真 input、自动聚焦），按标题/作者搜库、方向键或回车选择，选中即插入引用
- **⌘ `/zotero` 命令**：斜杠命令打开同一个搜索层，交互与 `&` 完全一致
- **🛠️ 模型工具**：注册 `resolve_zotero_ref`，模型看到 `{%ZoteroItem:key%}` 即可解析该论文的标题/作者/年份/摘要在库路径
- **🔗 Zotero 深链**：悬停引用可跳转 `zotero://select/items/...` 在本地点开原文

## 🚀 安装

**前置**：已装好 DSH（`dsh web` 能正常运行）、部署了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)、Node.js ≥ 20、pnpm ≥ 10，且本机装有 Zotero 桌面端（读取 `%LOCALAPPDATA%/Zotero/` 或 `~/Zotero/` 下的 `zotero.sqlite`）。

**macOS / Linux**：

```sh
curl -fsSL https://raw.githubusercontent.com/yuzh2001/dsh-zotero/main/scripts/install.sh | bash
```

**Windows（PowerShell 5.1+ / pwsh）**：

```powershell
irm https://raw.githubusercontent.com/yuzh2001/dsh-zotero/main/scripts/install.ps1 | iex
```

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可看到右侧栏的 Zotero 标签页（client 改动无需重启 DSH；仅 host 半改动时需要重启）。

<details>
<summary><b>指定 profile / 装完自动重启（可选）</b></summary>

```sh
# macOS / Linux：安装到指定 profile ext-dev，装完重启
curl -fsSL https://raw.githubusercontent.com/yuzh2001/dsh-zotero/main/scripts/install.sh | bash -s ext-dev --restart

# Windows PowerShell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/yuzh2001/dsh-zotero/main/scripts/install.ps1'))) -Profile ext-dev -Restart
```

不确定的话，可先加 `--dry-run`（PowerShell 用 `-DryRun`）预览步骤再执行。

</details>

<details>
<summary><b>手动安装（逐步命令，想看清每一步）</b></summary>

与一键脚本等价。**第 ③ 步可重复执行；①② 只需做一次。**

**macOS / Linux（bash）**：

```bash
cd ~/.dsh/profiles/web          # 换成你的目标 profile

# ① 放行构建脚本（pnpm 11 拦截）
pnpm approve-builds --all

# ② 放行新版本（一次性；若已有该键，把 - dsa-zotero-sidebar 并入其下即可）
echo -e "\nminimumReleaseAgeExclude:\n  - dsa-zotero-sidebar" >> pnpm-workspace.yaml

# ③ 安装并自动挂载（识别 dsh.bundle.patch，登记进 dsh.profile.bundles）
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsa-zotero-sidebar
```

</details>

<details>
<summary><b>脚本内部做了什么（技术细节）</b></summary>

一键脚本自动完成 5 件事（全部幂等，可安全重复执行）：

0. **上游依赖自检**：若该 profile 未装 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（本插件的宿主），先执行它的官方一键安装；
1. 预写 `allowBuilds`（规避 pnpm 11 的构建脚本拦截）；
2. 预写 `minimumReleaseAgeExclude`，放行「发布不足 24 小时」的新版本；
3. 执行 `dsh plugin --profile <profile> add dsa-zotero-sidebar`：登记依赖 → 识别包内 `dsh.bundle.patch` → 自动注册进 `dsh.profile.bundles` 挂载；
4. 清理旧版残留的手动挂载行，避免「双挂载」（页面出现两个 Zotero 标签）。

`curl | bash` / `irm | iex` 会执行远程代码——脚本已随仓库开源（`scripts/install.sh` / `scripts/install.ps1`），可先下载审阅。插件以 npm 包 `dsa-zotero-sidebar@0.1.0` 发布，通过 `dsh.bundle.patch`（随包的 `cordis.patch.yml`）由官方 CLI 自动挂载，**不修改 DSH 源码**。

</details>

<details>
<summary><b>更新</b></summary>

```sh
dsh plugin --profile web add dsa-zotero-sidebar
```

或重跑一次一键脚本；也可把 `~/.dsh/profiles/web/package.json` 里的版本号改高后 `pnpm install`。改完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可（client 改动无需重启 DSH）。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 右侧栏没有「Zotero」标签 | 需要先装好 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)；本插件挂在它提供的右侧栏上。 |
| 搜不到论文 | 宿主在 `%LOCALAPPDATA%/Zotero/zotero.sqlite`（Win）或 `~/Zotero/zotero.sqlite`（mac/Linux）找库；改过自定义 data dir 的话，用 `DSH_ZOTERO_DIR` 环境变量指过去。 |
| 报 `Ignored build scripts` | pnpm 11 拦截构建脚本。跑 `pnpm approve-builds --all`（一键脚本已自动处理）。 |
| 页面出现**两个 Zotero 标签** | 双挂载：`cordis.patch.yml` 还留着旧的手动挂载行，删掉那段 `- insert: ... zotero-sidebar ...`（一键脚本会自动清）。 |

</details>

<details>
<summary><b>从源码安装 / 开发（可选）</b></summary>

```sh
git clone https://github.com/yuzh2001/dsh-zotero.git ~/Dev/dsh-zotero
cd ~/Dev/dsh-zotero && pnpm install && pnpm build
# 把 ~/.dsh/profiles/<profile>/package.json 的 dependencies 写
# "dsa-zotero-sidebar": "link:~/Dev/dsh-zotero"
# 或直接 dsh plugin --profile <profile> add /path/to/dsa-zotero-sidebar.tgz
```

更新：`git pull && pnpm install && pnpm build` → 硬刷新（client 热加载；host 半改动才需重启）。

</details>

## 🔌 接入：作为 better-sidebar 的客户端

本插件通过 `ctx.betterSidebar.registerTab` 注册 `id: 'dsa-zotero:library'` 的 Zotero 标签页，与 better-sidebar 内置的 Explorer 等 tab 平级。

## 🛠️ 开发与构建

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm bundle      # tsdown → lib/index.js + lib/client.js + lib/types
```

**架构**：单 npm 包、host/client 双半结构——host（`src/index.ts`）：`/zotero/api` JSON 路由（library.tree / node.expand / search / item.resolve），直读本地 `zotero.sqlite`（`node:sqlite`），受 Host 头信任围栏保护；client（`src/client/index.tsx`）：better-sidebar 的 Zotero 标签页 + `&`/`/zotero` 引用浮层 + 背景懒加载。引用是**纯文本 token** `《题名》{%ZoteroItem:key%}`，不走 DSH 的 chip/occurrence 占位，因此光标永远对齐、不破坏输入。

## ⚠️ 已知限制

- 需要本机装着 Zotero（读它的 SQLite），不支持只读 Zotero Web API
- 双击/搜索引用插入的是题名字面 + key 的纯文本，不改写原库
- 首次读取大库树可能稍慢（懒加载按需展开）

## 🔗 友情链接

- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)：本插件的右侧栏宿主
- [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 提供 `ctx.betterSidebar.registerTab` 扩展点
