# DSH chip 显示策略研究报告

> 关于：在 DeepSeek Harness（DSH）主输入框（composer）中插入 reference chip 时，
> 如何让 chip 显示完整长标题（约 100 字符）且不破坏光标对齐。
> 本报告基于对 DSH 已发布包源码（`/Users/yuzh/.npm/lib/node_modules/@deepseek-ai/dsh/`，
> 版本 `0.1.0-rc.6`，minified 单体打包）的逐字阅读，以及网络资料调研。

---

## 0. 一句话结论（TL;DR）

**DSH 原生不存在「长文本 / 多行 / 自适应宽度」的 chip 变体，也没有任何开关、字段或事件能撑宽现存的 chip 胶囊。**
chip 被硬编码为「固定小胶囊 + `scale(0.72)` 缩放 + overflow 截断」，且这不是 CSS 修复能无损解决的——
因为单字符占位符（U+FFFC）的度量是这套双缓冲架构的对齐锚点，把 chip 撑宽一定会让文本流换行错位。

但是 **DSH 内置的第二套机制——「纯文本引用 + lexicon 派生高亮」——天然是「可变宽度 + 光标完美对齐」的**，
而且它已经在 skill（`/skill`) 和 subagent（`@`）两条触发链路上上线使用。**这是最正规、最稳的正确方向。**

---

## 1. 问题一：DSH 官方到底有没有「长/多行/自适应宽度」的 chip 变体或开关？

### 结论：没有。以下是源码证据（逐字段核对）

#### 1.1 chip 的契约类型：每个 chip 恰好占 draft 里的 1 个 U+FFFC

文件：`node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/input/contract.d.ts`

```ts
/** 每个 reference chip occurrence 恰好对应 draft 里的 1 个 U+FFFC 占位符。 */
export interface Occurrence {
    readonly occurrenceId: number;
    readonly source: string;
    readonly ref: string;
    /** Placeholder offset in the draft; the occurrence occupies exactly [offset, offset+1). */
    readonly offset: number;
    /** Chip display label (insert-time cache). */
    readonly label: string;
    readonly clipboardText: string;
    readonly invalid?: boolean;
}
```

`Occurrence` 的展示字段**只有 `label` 和 `clipboardText` 两个字符串**——
**没有任何 `width` / `multiline` / `maxWidth` / `mode` 之类的开关字段**。
`offset` 字段上面的注释明明白白写着：**该 occurrence 在 draft 中占据恰好 `[offset, offset+1)`——即 1 个字符**。

#### 1.2 输入事件：所有「插入 reference」的路径都只落 1 个占位符

文件：`.../lib/types/client/input/contract.d.ts` 的 `InputEvent` 联合类型。

- `'insert-ref'`：`{ reference: ReferenceInsert; span: TokenSpan }` → 在 span 处放 1 个 U+FFFC。
- `'paste-begin'` 的 `components` / `'paste-upgrade'`：同样每个组件放 1 个 U+FFFC。

文件：`.../lib/types/client/input/machine.d.ts`

```ts
/**
 * Shared chip-insertion transaction: replace [span) with one placeholder
 * occurrence (insert-ref and paste-upgrade both land here)... 
 */
private replaceSpanWithChip;
```

`PLACEHOLDER = "\uFFFC"`（`machine.d.ts` 第 3 行）——**整条 draft 在提交序列化时，会把每个占位符展开成它的 occurrence 的投影文本**（见 `projectClipboard`，注释：“U+FFFC never leaves the machine”）。

**结论：从契约层面，DSH 没有「多字符 span 替换」事件**。你用的官方事件 `slash/input-insert-reference`（`{reference, span}`）在 `.../lib/client.js` 1384 行被接到 `shell.insertReference(req.reference, req.span)`，走了同一条 `replaceSpanWithChip`，永远是 1 个占位符。

#### 1.3 chip 的渲染与 CSS：固定小胶囊 + 缩放截断（与你的实测完全一致）

文件：`.../dsh-client-ui-conversation/lib/client.js`（backdrop 渲染，3679–3704 行）

```js
backdrop.push(React.createElement("span", {
    className: clsx(styles.chip, chip.invalid && styles.chipInvalid),
    "data-decoration": "chip",
    "data-occurrence": chip.occurrenceId,
    "data-invalid": chip.invalid || void 0,
    title: chip.label,                       // ← 已有原生 hover title
    children: React.createElement("span", {
        className: styles.chipLabel,
        children: chip.label
    })
}));
```

文件：`.../lib/client.js`（`InputBar.module.css` 内联，`css$17` 字面量）

```css
.uV2eYG_chip{background:#6187d838;border-radius:6px;position:relative}
.uV2eYG_chip:before{content:"￼";color:#0000}     /* 用不可见占位符字符撑出度量单元 */
.uV2eYG_chipLabel{width:calc(138.889% - 10px);color:var(--dsw-alias-label-primary);
    white-space:nowrap;justify-content:center;align-items:center;display:flex;
    position:absolute;top:50%;left:50%;overflow:hidden;
    transform:translate(-50%,-50%)scale(.72)}
```

这三个规则正是你实测的现象：
- **`white-space:nowrap`** —— 绝不换行；
- **`width:calc(138.889% - 10px)` = 一个占位符宽度 × (1/0.72) − 10px** —— 把胶囊宽度锚定在「1 个字符所能容纳的约 72px」，跟 `label` 传多长无关；
- **`overflow:hidden`** —— 超出即截断；
- **`scale(.72)`** —— 整体缩放（所以视觉上约 74px）。

**这就是铁证**：chip 宽度由「占位符度量单元」决定，`label` 只是盖上去的背景文本，传 10 个字符和 100 个字符视觉宽度完全相同，都是截断。

#### 1.4 但 DSH 有**第二套**机制：纯文本引用 + lexicon 派生的高亮（text-ref）

这是本次调研最重要的正面发现。它在引擎里被显式称为「plain-text reference path」：

文件：`node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/types/types.d.ts`（`PickOutcome`）

```ts
/**
 * ... the token span is replaced with literal text — no occurrence identity,
 * no placeholder; any chip visual is derived downstream by scanning the
 * draft against the source lexicons.
 */
export type PickOutcome =
    | { readonly claim: CommandClaim }
    | { readonly insert: ReferenceInsert }   // ← U+FFFC 芯片胶囊
    | { readonly text: string }              // ← 纯文本 + lexicon 高亮
    | 'handled'
    | undefined;
```

配套的 `InputTriggerSource.lexicon?()` + 订阅，以及 `ReferenceCodec`：

文件：`.../types.d.ts`

```ts
/** 每个 trigger source 可选返回「热快照名字表」……渲染侧会对 draft 里 <trigger><name> 的完全匹配做装饰。 */
lexicon?(session): readonly string[] | undefined;
```

渲染侧（`dsh-client-ui-conversation`）：

- 装饰推导：`deriveDecorations(state, lexicon)`（client.js 2415 行）；其中 `scanTextRefs` 用正则 `/(^|\s)([/@])([\w-]+)/g` 扫 draft，凡命中 lexicon 的词条就产出 `TextRefRange`（decorations.d.ts 30–34 行）。
- 渲染：`"data-decoration": "text-ref"` 的 `<mark className={styles.textRef}>`（client.js 3706–3710 行）。
- CSS：`.uV2eYG_textRef{color:var(--dsw-alias-state-business-primary);box-decoration-break:clone;background-color:#0000}` —— **无缩放、无 nowrap、无固定宽度，是普通行内元素，随内容自然撑宽、自然换行**。

**关键差异**：text-ref 的 textarea 真实 value 里存的是**字面文本 `/name`（普通字符）**，不是 U+FFFC。因为文本流两侧完全一致，光标度量天然精确，**宽度可变也绝不破位**。

**它已在产线上被两个 trigger source 使用**：
- 文件：`dsh-client-ui-skill/lib/client.js`，305 行：`onPick({candidate}) { return { text: '/'+candidate.name+' ' } }`。
- 文件：`dsh-client-ui-subagent/lib/client.js`、`dsh-client-ui-cordis/lib/client.js` 都实现了 `lexicon()`。

也就是说：skill、subagent、cordis 命令并不是用「U+FFFC 胶囊」，而是用「纯文本 + lexicon 高亮」这条路径。**你的 Zotero 引用完全可以复刻同一条机制。**

> 注：这解释了为什么所有已发布 trigger source 里都搜不到 `return { insert: ... }`——胶囊 chip（insert 路径）在正式包里几乎没有被实际采用；各 source 更多的是走 text/lexicon。

---

## 2. 问题二：编辑器 @mention / chip 通用范式（调研小结）

主流编辑器处置「前景显示宽内容 + 光标对齐」其实只有两大流派：

**A. 内容模型即宽标签（推荐方向，对应 DSH 的 text-ref）**
把 mention 作为**文本中的一个普通字符序列**存在于真实编辑内容里（`@name`），编辑器全程按普通文本量度；前景层只是**给它涂色/加背景**（decoration），而不替换成「窄占位符」。因为 show 的内容 = 真实内容 = 度量内容，天然零错位、可宽可换行、可跨行复制粘贴。
- [react-mentions（最流行 textarea mention 库）](https://www.codeline.co/thoughts/repo-review/2024/react-mentions-textarea-with-mention-support)：用**前景覆盖/高亮**文本里的 `@username`，textarea 仍是普通文本，绝不在真实值里放窄占位符。
- [react-mentions-ts DeepWiki UI Components](https://deepwiki.com/hbmartin/react-mentions-ts/6-ui-components)：同一 overlay 高亮模型。
- ProseMirror / tiptap 的 mention Strict/literal：通常存全名或 id，行内节点可带自己的 CSS，宽度自适应。
- [Obsidian Decorations 文档](https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Plugins/Editor/Decorations.md)：同样用「文本装饰覆盖颜色/样式」让普通文本“像 chip”，不替换窄占位符。

**B. 窄占位符替换 + 前景渲染成胶囊（对应 DSH 的 U+FFFC chip）**
真实内容只留 1 个「object replacement character / mark」或 1 个行内 node，前景把它画成胶囊。**对位方式只有两种**：
1. 用「测量占位」——胶囊自身占的宽度 ≈ 真实占位符宽度（DSH 用 `::before{content:"￼"}` 制造一个度量单元，`width:calc(138.889% - 10px)` 就是「一个单元×1/0.72」）。这要求胶囊宽度被锁死在占位符宽度附近，**一旦撑宽就破坏流布局**——这正是 DSH 的硬约束。
2. 交给编辑器引擎测量该 node 的真实宽度并同步到光标位置（ProseMirror 行内 node、CodeMirror deco.widget / markSpans 是引擎级测量，[CodeMirror 光标高度随 widget 高度问题](https://discuss.codemirror.net/t/cursor-changing-heights-over-widget-created-spans/9148/4) 说明这是引擎专门处理的难点）。**但 DSH 的 textarea 不是 ProseMirror/CodeMirror，没有任何引擎级测量通道**——它只靠「双缓冲同步渲染同一份文本」，本质是流派 A 的简化版。

GitHub / Slack / Notion 的 @mention 显示名较长时，普遍也是让 mention 行内 node 撑宽（它们有内容模型），并在 hover 给完整描述。

**小结**：没有任何成熟产品用「窄占位符 + 无引擎测量」去渲染一个任意宽、可换行的胶囊还想保住光标。要么走流派 A（宽文本 + 高亮），要么接受流派 B 的「紧凑胶囊 + tooltip」。

---

## 3. 问题三：在 DSH 双缓冲下让 chip 显示完整长标题的可行方案

先说清架构约束（决定一切方案的评价）：

- 光标对齐锚点 = textarea 真实 value 与 backdrop 前景层的**逐字同步**。chip 用 1 个 U+FFFC 占位，backdrop 在同样位置渲染胶囊，`cursor = chip.offset + 1`。
- `.uV2eYG_input`、`.uV2eYG_backdrop`、`.uV2eYG_mirror` 三者在 `white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere` 下同宽度量（同一行「font-family:DshChipCell,…」、`font-size:inherit;line-height:inherit`）。**只要 backdrop 里 chip 占的宽度 ≠ textarea 里 1 个占位符的宽度，回车位置的文本换行就会分叉，光标错位立刻发生。**
- 因此：**任何把胶囊「真实撑宽/折行」的改动，都必须由引擎同步把 textarea 里相应位置也撑宽**——但引擎对 chip 只有 1 个占位符，没有宽度通路。**除非你把内容变成字面文本（text-ref），否则无解。**

下面按可行性排序。

### 方案 A（★ 最推荐）：走「纯文本 + lexicon 高亮」而非胶囊

不引入 U+FFFC。让你的 Zotero reference 以 `@短标签`（或自定义 `@`-族）**字面插入 draft**，同时你注册一个 trigger source 提供 `lexicon()` 把该标签加入高亮词表。DSH 会自动把 `@短标签` 渲染成行内 `<mark data-decoration="text-ref">`——**可变宽、可换行、光标零错位**。提交时由你的 `ReferenceCodec.serialize(ref)` 把标签还原成模型序列化（如 `<zotero>key</zotero>`）。
- 可行性：**高**。机制被 skill/subagent/cordis 生产使用，是官方一等的 reference 通道。
- 风险/注意：
  1. `scanTextRefs` 正则 `([/@])([\w-]+)` 只匹配 **单词字符（字母/数字/下划线/连字符，不含空格）**、且 trigger 后必须紧跟词条；**句内含空格的长标题走不通**。→ 用「短标签/短 ID」作高亮键即可（如 `@zotero-X7F9`），完整标题放 tooltip / 待提交序列化，符合常用产品形态。
  2. 这正是行业通用做法（第 2 节流派 A），无光标风险。
  3. 若想显示完整标题而非短标签，可在**临近位置**（例如紧跟其后的正文、或 hover）给出全文，但不放进高亮 token 本身。
- 提交链路：需要实现 `ReferenceCodec`（`clipboardText(ref)` + `serialize(ref, signal)`），让 `/zotero` 标签在 submit 时被替换为真实 model 形式（`contract.d.ts` 里 ReferenceCodec 注释：序列化失败会阻止发送，是刻意设计）。

### 方案 B：注入 CSS 改 chip 样式（你提到的 profile patch / client plugin）

技术可行性：可以做到视觉效果「胶囊变宽/变高/可换行」，但**必然破坏光标对齐**，需配合更多 hack，不推荐单独使用。
- 用动态 client plugin（在浏览器里 `document.createElement('style')` 注入即可）改 `.uV2eYG_chip` / `.uV2eYG_chipLabel`：去掉 `white-space:nowrap`、去 `scale(.72)`、让它内容撑宽。
- 但后果：backdrop 里 chip 撑开后，其占据的宽度远大于 textarea 里 1 个 U+FFFC 的宽度 → 从该 chip 之后的行 / 回车，backdrop 与 textarea 文本流**分叉** → 光标错位、输入错位。
- 可用稳定选择器：**不要用 hash 类名**（`.uV2eYG_*` 是 CSS Module 哈希，升级就变）；可靠选择器是 **`span[data-decoration="chip"]`**（client.js 3695 行固定输出），以及其内部 label `span`（其子元素）。
- 若要「既宽又不破坏整体光标」，需同时让 textarea 侧同步变宽——**DSH 没有这个通道**，只能用更脆的 hack（例如把 chip 做成 `position:absolute` 弹出式浮层，悬停到 chip 时才展开一个不参与布局的浮层）。这就是方案 D 的定位。

### 方案 C：chip 内折行 / 缩进规避光标错位

**不可行作为主方案**。正文里 `.uV2eYG_backdrop` 与 `.uV2eYG_input` 是同一文本流，任何让 chip 高度增长（折成两行、内边距增大、行高变化）都会让该行高度在 backdrop 与 textarea 之间不一致，未随后的行/光标整体错位；textarea 又无法单独给 1 个占位符加高。仅当 chip 位于**独立的一行（独占回车段）**时折行才不会影响别处，但产品上很少让引用独占一行。

### 方案 D（兜底，最稳妥的产品形态）：保持紧凑胶囊，信息完整放 tooltip

保留现有 U+FFFC 胶囊（这正是你现在已经具备的），把完整标题放进：
1. **原生 `title` tooltip** —— client.js 3698 行已无条件输出 `title: chip.label`，**完全不需要任何改动**，hover 即显全文。
2. label 用短标题（如「Smith 2024」），`title` 放完整标题；label 是 `ReferenceInsert.label`，tooltip 文本也是 `label`（当前实现 tooltip 与 label 同源）。

- 可行性：**极高**，零代码或极少量改动。
- 局限：必须接受胶囊固定宽度视觉 + 截断 + tooltip 展开。

### 补充：动态 client plugin 与「不改官方包」的边界
- 「不改 DSH 官方文件」完全成立：上面所有方案都不需要改 `node_modules` 里的包。动态 Cordis client plugin（client 半区）+ `actx` 即可。
- 方案 A 的注册点：你的插件在 host 侧提供 trigger source（`InputTriggerSource` + `lexicon()/codec`），或复用 `@`/`/` 触发进入同一管线；这与 conversation 输入层衔接是现成链路（`dsh-client-ui-input-trigger` 的公开契约）。
- 注意：skill/subagent 每条触发链都以一个全局唯一 `trigger` 字面量 + `name` 注册；多个 source 共享 `@` 由管线按 `order` 聚合，不会冲突。

---

## 4. 最终推荐方案

**首选 —— 方案 A：以「纯文本短标签 + lexicon 高亮」作为 Zotero 引用的正式插入形态。**
理由：
1. 它就是 DSH 官方为 skill/subagent/cordis 设计的 reference 通道，机制正统、被生产使用，且**没有「窄占位符 vs 宽显示」的光标矛盾**——这是唯一「既能宽、又零错位」的路径。
2. 短标签（如 `@zotero: <itemKey>` 的紧凑词法，避免空格）用 `ReferenceCodec.serialize` 在提交时还原成 model 形式，功能完全等价于胶囊，但视觉与 cursor 都由引擎担保。

**降级/兜底 —— 方案 D：保留 U+FFFC 紧凑胶囊 + 原生 `title` 完整标题 + label 用短标题。**
当产品确实需要「胶囊只读、不可编辑」的强语义时使用。成本趋近于零、稳定性最高，代价是固定宽度截断。

**明确不建议单独采用**：方案 B（纯 CSS 撑宽，破坏光标）与方案 C（折行）——没有 DSH 引擎级测量通道，本质上无法在「宽内容」与「光标对齐」间两全。

---

## 附：涉及源码证据文件清单

| 文件（均在 `dsh/node_modules/@deepseek-ai/` 下） | 关键证据 |
|---|---|
| `dsh-client-ui-conversation/lib/types/client/input/contract.d.ts` | `Occurrence` 仅 `label/clipboardText`；`[offset,offset+1)`；`InputEvent` 全部只落 1 个 U+FFFC |
| `dsh-client-ui-conversation/lib/types/client/input/machine.d.ts` | `PLACEHOLDER="\uFFFC"`；`replaceSpanWithChip`；U+FFFC never leaves machine |
| `dsh-client-ui-conversation/lib/client.js` | 渲染（3679–3712 行）：`data-decoration="chip"`/`title`/`text-ref`；`scanTextRefs` 正则 `(^|\s)([/@])([\w-]+)`（2378/2388 行）；`deriveDecorations`（2415 行）；事件接线 `input-insert-reference`（1384 行） |
| `dsh-client-ui-conversation/lib/client.js`（`css$17`） | `.uV2eYG_chip` / `.chipLabel`（nowrap+scale(.72)+hidden）与 `.uV2eYG_textRef`（可宽可换行）CSS |
| `dsh-client-ui-input-trigger/lib/types/types.d.ts` | `ReferenceInsert`、`PickOutcome.text`（纯文本路径）、`InputTriggerSource.lexicon()`、`ReferenceCodec.clipboardText/serialize` |
| `dsh-client-ui-skill/lib/client.js` | 305 行 `onPick → { text: '/'+name+' ' }`：生产级纯文本路径实证 |
| 由项目源码日期 `2026-07-25-web-input-machine-and-slash-pipeline.md` 指代的设计笔记 | 「plain-text reference decision」决策说明 |
