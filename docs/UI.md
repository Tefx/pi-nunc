# Nunc 状态与记忆管理界面

状态：**人工 M 状态与恢复已实现；footer / overlay 尚未实现**。更新于 2026-09-08。

本文记录用户确认的紧凑状态栏、Slots 管理与 Context 布局浏览方案。§5–§6 的有效 M、revision、预算与 `replace`/`delete` 已由 Pi adapter 提供，可在无面板的公开 host fixture 中验证。footer、两个 tab 与 TUI 交互仍待后续步骤。现有核心与兼容修复的完成历史保留。

本设计延续 [DESIGN.md](DESIGN.md) 的 session、来源、原文、容量与 Pi 所有权边界。人工保存按 §5 扩展原先仅在 CompactionEntry 保存 M 的合同。[PI.md](PI.md) 与 [ENGINE.md](ENGINE.md) 中当前预算及 Provider 组合合同仍适用。示意文案、尺寸起点、私有数据格式和模块文件划分是推荐；实现可以替换它们，但须保持本文明确的用户行为、状态所有权、观察边界与兼容限制。

## 1. 用户能力与命令兼容

交付一个 footer 状态项和一个含 Slots、Context 两个 tab 的 overlay。查看、编辑、删除不调用模型，不触发 compaction，不发送用户消息。

| 命令 | 当前实现 | UI 实现后的行为 |
| --- | --- | --- |
| `/nunc` | 三行文字概览 | TUI 打开 overlay，默认 Slots；其他模式保留文字概览 |
| `/nunc status` | 尚未支持 | 显式文字概览，不打开面板 |
| `/nunc details` | 分组预算与最近维护详情 | 保留既有内容、千位分隔和无模型请求行为 |

原生参数补全保留 `details`，新增 `status`。未知参数显示用法。只读命令不追加 session 记录；人工保存是唯一新增的持久化操作。自定义组件仅在 `ctx.mode === "tui"` 使用；RPC 的 `hasUI` 为真不表示有终端 overlay。此版不提供非 TUI 人工写入命令或新的模型工具。

首版范围为状态、Slots 浏览/搜索/单条编辑/删除、Context 分层浏览及最近观察。不加入批量修改、回收站、永久 pin、AI 自动修订、跨 session 记忆、配置编辑器或维护调度器。

## 2. 紧凑 footer

使用 `ctx.ui.setStatus("nunc", …)`，不替换 Pi footer，不增加常驻 widget，不修改其他扩展的状态。

| 示例 | 语义 |
| --- | --- |
| `nunc 8·42%` | 8 个已保存有效 slots，占当前 M 规划预算约 42% |
| `nunc ↻ 8` | 维护进行中，包含等待 Pi 提交的阶段 |
| `nunc ! 8` | 当前有需要查看的诊断 |
| `nunc ×` | 当前配置或状态无法使用 |

通常占 8–12 列，重要信息在前；无需 Nerd Font。正常状态使用低对比度文字，维护使用 `accent`，诊断使用 `warning`，不可用使用 `error`，同时用字符区分状态。数值无法计算时显示未知，不用零或旧模型的比例代替；空记忆可正常浏览，零预算不作除法。超额比例不截成 100% 来掩盖实际状态。

百分比表示 M 预算占用，不重复 Pi 的整体 context 使用率。H、模型、详细预算与完整诊断进入面板或文字详情。状态由 session、模型、维护、保存及观察事件更新，无轮询、额外模型请求或持续动画。保存前草稿不改变 footer 的已保存条数。恢复成功后清除当前警告，最近诊断仍可在详情查看。

Pi 默认 footer 会拼接并截断多个扩展状态。自定义 footer 只有消费 `getExtensionStatuses()` 才能显示它们；Nunc 不为强制可见而接管 footer。

## 3. Overlay 与 Slots

### 3.1 共同布局

视觉参考现有 Larva selector、Conversation Markdown Export 和 Sticky Reader：居中、圆角边框、一列内边距、轻阴影、上方搜索和列表、下方选中项详情。推荐宽 90%、最大高 90%、margin 1，内容少时缩短高度；按可用终端尺寸调整，短屏仍保留必要操作提示和退出路径。尺寸是起点，不要求在过小终端强行保持固定布局。

颜色使用当前 Pi theme，采用原生 `Input`、`SelectList`、`Editor` 等组件。遵守可见列宽、ANSI 安全截断、换行和 invalidation；主题改变后不残留旧颜色。容器向输入组件传递焦点，支持中文 IME、粘贴和原生光标操作。UI 截断仅影响预览，不修改记忆或真实上下文。

```text
╭─ Nunc ──────────────────────────────────────╮
│ [Slots]   Context                           │
│ Ready · 8 slots · M ≈840 / 2000              │
│ Search…                                     │
│                                             │
│ › s12  必须兼容 Node 18                      │
│   s15  上传成功后不得自动重试                │
│   s19  尚未验证 Windows 路径处理             │
│ ─────────────────────────────────────────── │
│ s12                                         │
│ 必须兼容 Node 18。Node 22 的测试通过不能      │
│ 替代 Node 18 的兼容性验证。                  │
│                                             │
│ ↑↓ select · Enter edit · Ctrl+D delete       │
│ Tab switch · Esc close                      │
╰─────────────────────────────────────────────╯
```

内容和数字仅作布局示意。

### 3.2 交互

- `/nunc` 默认 Slots；浏览态 Tab 切换两个 tab。编辑态 Tab 留给原生编辑器，避免抢占补全。导航、确认、取消使用注入的 keybindings，提示与实际绑定一致。
- 搜索匹配 slot ID 与正文，选择即预览全文。当前 Slot 只有 `id/text`，不编造来源、置信度、创建时间或过期时间。
- Enter 进入多行编辑。沿用 Pi 默认 Enter 保存、Shift+Enter 换行、Esc 取消，并遵守其可配置按键。
- Ctrl+D 仅在列表态删除当前 slot；确认框显示 ID 与摘要，确认一次。编辑器内的删除键仍删除文本。空正文给出校验反馈，删除通过显式删除操作完成。
- 保存失败保留草稿；成功返回列表并维持合理的邻近选择。搜索无结果、无 slots、无观察与配置错误都有明确状态，不能伪装为空且正常。
- Escape 优先取消最内层编辑或确认，再返回列表或关闭 overlay。取消有改动的编辑需明确丢弃意图，不能因 resize 或 tab 切换静默丢草稿。
- 打开、关闭和嵌套 UI 不覆盖主输入框草稿。关闭面板不顺带 abort 背景 agent；普通 Pi 的主动取消行为仍可在面板关闭后使用。面板、订阅与临时状态随关闭或 session teardown 清理，不复用已销毁组件。

## 4. Context：当前布局与最近观察

### 4.1 粒度

Context 与 Slots 使用一致的带版本 view。默认显示当前投影的 F/M/R，占用条仅是大小估算的辅助表示；数值和未知标记保留。选中 M 可跳到对应 slot。

| 层级 | 显示内容 |
| --- | --- |
| F | 有效 system prompt、工具定义；分别展开并列出数量与估算 |
| M | 当前有效记忆与 slot 数量、预算占用 |
| R | 已交付且仍在活动上下文中的原文 |
| 消息 | 顺序、角色、估算大小、短预览 |
| 内容块 | 按需展开 text、可读 thinking、toolCall、toolResult 内容、image 等实际组成 |

消息数与内容块数分别统计，例如 `26 messages / 41 blocks`，不将 slot、消息、工具定义混成一个 block 数。工具调用和结果按实际关联展示，不移动、复制或隐藏真实请求中的关联单元。用户可查看长正文；不为浏览打开已退役历史或外部日志附件。

### 4.2 三种观察范围

1. **当前投影**：当前选定路径上已交付的状态和有效 F/M/R。它不声称包含之后才运行的 context/payload hooks。
2. **最近一次主请求观察**：Nunc 观察点取得的请求组成，标明模型、观察时点和范围。它与当前投影分别标识；被本地拒绝的请求不得标成已经发送或完成。已有观察能证明的生命周期状态才显示。
3. **最近一次维护**：实际冻结的 B/K 划分、前后布局与结果。候选成功不等于 Pi 已保存；保存状态依据原生提交/失败事件。失败或取消时不显示不存在的已提交新布局。

B/K 在维护时确定，当前 R 不预测为已经确定的下一次切分。排队或尚未交付的 D 不计入布局。其他扩展增加、过滤自己的 context 消息或追加多个 payload 文本块时，只显示实际观察到的差异；不能映射到消息块的追加单列，不把临时注入回填成维护来源或持久 M。未覆盖部分明确为未知，不为 inspector 增加通用 provider mapper。

最近观察限当前 session/路径的内存状态；模型改变后的历史观察必须保留自己的模型标签。切换 session/路径或 reload 后没有适用观察时显示暂无记录，不加载旧分支数据冒充当前请求。维护前布局需要的观察在冻结时采集，不在退休之后回读正文。无需新增持久化 context/payload 日志，也不向诊断事件或通知输出完整正文、headers、credentials 或私有环境内容。

### 4.3 估算与预算

遵守 [ENGINE.md](ENGINE.md) 的当前口径：

- 分项使用 `pi-heuristic`：Pi `estimateTextTokens` 的 UTF-16 字符/4 估算，加现有 framing 与已配置的图片估算。它不是 tokenizer 或硬上界；不恢复 `utf8-upper-estimate-v1`。
- M 与维护/候选始终重新估算。主请求总量仅在原有模型、F 和已交付前缀仍适用时可标为 `pi-usage-backed`；人工修订等前缀变化使旧 attribution 失效。
- 分项新估算的总和与 usage-backed 总量可能不同，分别标注，不按比例伪造逐块实测。请求/消息包装及不可归属的开销单列，避免重复计算 F/M envelope。
- 图片无可用估算时显示 `unknown`，总量说明不完整；浏览未知数据不取消发送时的媒体/容量保护。
- Provider usage 只作对应请求总量参考；cached tokens 仍占上下文，缺失或未报告数据不按零计算。usage 不证明费用结算。
- 模型窗口、输入规划上限、H、M 预算、输出规划预留与实际输出 cap 分别展示。主请求保留现行 `nativeOutputReserve` 与 Pi 原生 output/thinking；不能把 Nunc 总量和 Pi 已 clamp 的 cap 当成同口径联合保证。
- extraction 默认 `min(8192, model.maxTokens)` 是独立规划值；uncapped Codex/Responses 的 cap 为无，不能把规划值标成强制 cap。调用消费授权仍覆盖真实原生能力。
- 正常触发余量建议与输入/输出超规划记录保留。`normalExtractionAtTrigger` 为 advisory，不能阻止当前可容纳的 manual/overflow 维护。UI 不写 Pi settings 或自动调整 H。

已有 `/nunc details` 的主/维护输入规划、输出预留、维护 cap、最新 accounting、headroom advice、overrun 内容仍可通过文字入口和相关详情访问。

## 5. 人工记忆提交与兼容

### 5.1 状态所有权

Pi 是唯一 session 持久化所有者。推荐通过 `pi.appendEntry()` 保存原生 CustomEntry，承载人工修订后的完整 M 及恢复其归属所需的最少版本信息；不保存另一份 K，不改旧 JSONL，不建立数据库、双写账本或新 hash/CAS 协议。具体私有编码可用保持相同行为的实现替换。

Pi adapter/projection 是唯一有效 M 投影所有者：当前路径最新原生 checkpoint 加其后适用的人工修订。UI、主 context 和维护读取同一结果。人工记录不作为 R 或模型可见的额外消息；主 context 更新唯一 M 载体，K 和真实原文保持原样。旧 checkpoint 的 summary/details 一致性校验保留，人工结果不伪装成对旧 entry 的原位更新。

下一次正常维护冻结有效 M，并将结果交给 Pi 保存为新的 CompactionEntry；此前已吸收的人工记录不能重新覆盖新记忆。resume/reload/tree/fork/clone 遵循选定路径，new 为空。显式回到修改之前的历史点恢复当时状态；普通恢复到修改之后的路径不能因旧 snapshot 而复活已删条目。未修改条目和相对顺序保持；推荐人工文本编辑保留其 slot ID，计数器沿用既有 Memory 语义。

删除清除当前 M 中的条目，不擦除 JSONL 历史，也不永久禁止未来从有效证据提取同类事实。人工编辑不构成永久 pin，后续正常维护仍可纠正或退役。

### 5.2 生效、并发与错误

保存成功后首次新构造的请求使用新 M。已构造或发送的请求保持原样，不 abort、不 replay，也不因更新 UI 失效其合法在途调用。以后新请求不能继续借用修改前的 usage attribution。

人工保存与维护从冻结到 Pi 提交成功或失败的窗口互斥。等待终态期间可以编辑本地草稿，但不可保存；不能在 engine 返回候选时提前解锁并容许随后的原生提交覆盖人工修改。普通 agent run 不整段锁写。提交操作只短暂拥有校验与原生追加边界，不引入后台待保存队列。

提交需基于所读的会话、所选路径和记忆 revision。revision 使用现有状态身份或等价轻量机制，目的是发现草稿期间的相关状态改变，不要求 hash、磁盘 CAS 或对不相关扩展 entry 一律报冲突。模型、工具或配置变化后使用当前预算重新校验。

| 结果 | 用户与状态行为 |
| --- | --- |
| 保存成功 | 刷新两个 tab 和 footer 的已保存 view；不触发模型请求 |
| 取消 / 校验失败 | 不追加、不修改有效 M；失败保留草稿和具体原因 |
| revision 冲突 | 不静默覆盖，保留草稿，要求核对当前内容 |
| 维护占用 | 保留草稿，说明维护尚未完成，不 abort 维护 |
| 超预算 | 增长型编辑不能截断正文或淘汰其他 slots；显示当前预算与候选估算 |
| Pi 写入错误 | 显示“保存未确认”，不自动重试、不宣称旧内存完全未变；继续写入前核对原生状态 |

删除、缩短可以逐步减少已经超额的 M，不要求先使整个主请求符合容量或低于 H，也不借人工编辑移动 K。仍超额时保留诊断，实际发送继续经过原有 admission。增长型编辑须满足当前 M 预算；预算不可计算时不假装通过。校验复用完整 slots 与现有 Memory 合同，不增加任意字符/条数上限。

### 5.3 迁移与卸载限制

现有会话无需改写，旧式外部 summary 继续按既有 legacy slot 规则读取。**尚未纳入下一次原生 compaction 的人工修改，需要新版 Nunc 解读；卸载 Nunc 或退回旧版时，stock Pi 仍读取上一次原生摘要。** 新版重新读取同一保存路径时使用仍适用的人工记录。UI 文档和人工保存入口应明确此限制。

此边界是即时、零模型调用保存的已接受代价。Pi 0.85.1 的 `compact()` 会先 abort，且在刚压缩完或历史过短时于 hook 之前拒绝，不能作为每次人工保存的可靠入口。不为消除此限制引入 Pi core patch、替代 launcher、直接 JSONL 改写或强制整理。

## 6. 实现者需要的边界

| 所有者 | 职责 / 消费者 |
| --- | --- |
| UI | 展示只读 view、选择/搜索/草稿；发出单条编辑或删除意图，不持有另一份有效记忆 |
| Pi adapter / projection | 有效 M、revision、原生保存与维护协调；向两个 tab、footer、context、maintenance 提供一致状态 |
| 请求 / 维护观察 | 从现有 Nunc 观察点提供有范围标签的数据；不改变分类、委托、payload 或返回值 |
| Engine / accounting | Memory 校验、渲染、估算与预算；不依赖 TUI，不写 session |

内部消费接口由 `pi-nunc/pi` 的 `memorySurface(pi)` 提供（同一扩展实例，经公开 event bus 绑定，不是新 SDK 或临时写命令）。`read(ctx)` 返回 `{revision, memory, status, budget, contextLayout}`：`revision` 标识当前 session 与适用的 native checkpoint / 人工 head，不因无关扩展 entry 变化；`memory` 是唯一有效 M；`status.occupied` 为维护冻结至 Pi 提交终态；`budget` 使用当前模型/F/tools/config 的 `pi-heuristic` M 规划，不可计算时 `unknown: true`；`contextLayout` 给出 slot 数、活动原文条目和最新 checkpoint id。`replace(ctx, revision, slotId, text)` / `delete(ctx, revision, slotId)` 经公开 `pi.appendEntry()` 写入私有 `nunc.memory` CustomEntry，结果为成功或 `invalid` / `conflict` / `occupied` / `overbudget` / `unknown-budget` / `unconfirmed`。UI 只读观察不得阻止合法调用；未知数据留空并标注。

UI 的只读观察不应阻止合法调用，未知数据留空并标注。保留已交付的合作 Provider 链、独立调用透明委托、一次性维护绑定、多块末条 user 文本追加、取消与工具/媒体/输出保护；不恢复旧 main-request tickets、全量 payload 修改禁令或扩展名白名单。

## 7. 验证与证据边界

实施后验证下列行为；本次文档更新不声明已运行这些 UI 检查：

- 原生 TUI 的 footer 共存、两个 tab、搜索/预览/编辑/确认、合理选择恢复；窄/短终端、长文本、CJK/IME、paste、theme、resize、嵌套 focus 与 Escape。IME 候选窗口等自动化无法充分证明的行为明确补人工观察，不用输入文本断言冒充证明。
- 当前和最近请求/维护的范围、F/M/R、消息/内容块计数、tool 关联、包装、fresh 与 usage-backed 差异、未知图片、无记录、本地拒绝、多扩展追加及尚未交付 D。主请求观察不回填维护来源。
- 原生命令补全，`details` 向后兼容，新增 `status`，非 TUI 降级；仅浏览无模型/compaction/session-write 效果，人工保存仅产生预期原生记录。
- 实际保存后首次新请求中的唯一有效 M，K/队列/主编辑器/在途请求不变；原生 session 重启、reload、新建、分支/恢复、后续 compaction 吸收与旧记录不重放。
- engine 候选完成至 Pi 提交终态的竞态、revision 冲突、模型/预算改变、逐步减少超额 M、空文本、取消、持久化错误与草稿保留。不把候选观察当持久化凭据。
- 受影响的 native Provider/append/usage 归因与原有媒体、tool、容量、取消回归；整合后的现有完整检查 inventory 通过。历史测试数不作为固定目标。

使用真实 stock Pi 与合成 session/受控服务证明机械行为；RPC/组件测试不能代替实际 TUI。生产者同时交付必要 source/tests/跟踪 runner，检查不依赖其他项目的绝对路径。复用适用的核心/兼容/真实模型观察，不因 UI 或文档变更默认重跑付费案例；出现确实受影响的语义缺口才在相应执行授权下决定补证。

## 8. 依据

- 当前产品：`src/index.ts` 的命令与维护生命周期，`src/pi/projection.ts` 的 active-path/M 投影，`src/pi/admission.ts` / `payload.ts` 的原生组合观察，以及 `src/engine/{types,memory,accounting}.ts`。
- 支持目标：锁定 Pi/pi-ai 0.85.1 的公开 Extension API、`appendEntry()`、`context`、原生 compaction 事件及 TUI 组件。已核对 `compact()` 的先 abort/准备失败边界。安装目录的文档若与锁定源码不同，以所选公开类型和实际源码为准。
- 只读风格参考：`/Users/tefx/Projects/larva/contrib/pi-extension/larva.ts`，`/Users/tefx/dotfiles/agent/pi/extensions/conversation-md-export/index.ts`，`/Users/tefx/dotfiles/agent/pi/extensions/sticky-reader/index.ts`。这些路径记录设计来源，不是构建依赖、写入目标或新的兼容承诺。
