# 主动 CRUD、唯一尾置 M 与 usage receipt

状态：**已按本规范实现于 impl/nunc-active-memory 分支**。

完整交付包括主 agent 读/增/改/删统一 M、原子提交、唯一尾部请求载体、稳定 R 与移动 M 分离的 receipt，以及旧布局自动转换。Larva 指令桥接已独立交付，本功能消费该结果；Larva 的 v1 接口和调度条件保持不变。所有修改限于 Nunc，不改 Pi core、已安装 Pi 包、私有宿主状态或外仓。

## 1. 接受范围与取舍

完整交付包括主 agent 读/增/改/删统一 M、原子提交、唯一尾部请求载体、稳定 R 与移动 M 分离的 receipt，以及旧布局自动转换。不能先上线尾置再留下 receipt 不可复用的问题，也不按 CRUD/helper/tests 拆成碎片交付。

用户最新决策覆盖此前兼容建议：**只维护新布局 F → R → M，无前置回退、无双布局开关，不承诺旧版 Nunc 运行兼容。** 已接受首次转换和重新建立 receipt 的 token 开销；这不解除容量检查，也不代表尾部 M 在后续请求中没有重复处理成本。

唯一 M、slot ID、revision、有效路径投影由 Nunc 管理；Pi 独占原生追加、checkpoint、模型/auth/serializer/transport、工具、队列与压缩调度。普通 compaction 必须独立正常工作，不要求主 agent 先记笔记。无第二笔记库、跨 session store、永久 pin、后台保存队列、额外摘要模型或自动调用频次要求。

可选模型工具开关仅控制工具暴露，不控制 M 布局。支持 CLI 标志 `--nunc-memory-tools` 或 Pi 配置 `settings.json`（全局 `~/.pi/agent/settings.json` 或受信任项目 `.pi/settings.json` 中 `{"nunc": {"memoryTools": true}}`），默认关闭。优先级为：显式 `--nunc-memory-tools` > 受信任项目布尔配置 > 全局布尔配置 > false。项目未受信时不生效；配置非布尔值按 CONFIG 诊断模式明确拒绝，不通过布尔弱类型转换误启用。即使工具关闭，新版本仍统一使用尾置 M，人工编辑与 compaction 继续工作。工具启用不授权扩大 Pi/Larva 的工具权限，实际可见集合继续服从宿主管理；不要求运行时热切换开关。

## 2. 模型工具合同

### nunc_memory_read

返回唯一有效 M 的脱离快照：

```typescript
{
  revision: string;
  slots: Array<{ id: string; text: string }>;
  budget: { usedTokens: number; limitTokens: number | null };
  writable: boolean;
}
```

`writable` 表示目前没有维护冻结或保存未确认等提交阻塞，不保证任意 patch 都合法或可装入预算。预算未知时仍可允许删除/缩短；limitTokens 为 null 不能伪装成零或无限。模型写入前取得 revision，不把 revision 或当前 leaf 自动塞进每次注入的 M 文本。只读不追加 entry、不发模型、不触发压缩。

### nunc_memory_patch

```typescript
{
  expectedRevision: string;
  add: Array<{ key: string; text: string }>;
  update: Array<{ id: string; text: string }>;
  remove: string[];
}
```

- add 的 key 是本批次局部标识，唯一且不与现有 slot ID 混淆；正式 ID 由系统按既有 nextId 语义分配，失败不消费 ID。
- update 指向现有 slot，保留 ID 与位置；remove 明确指向现有 slot。
- 同一现有 slot 每批最多被操作一次；未知 ID、重复目标、update/remove 冲突、非法字段/类型或空文本整批失败。
- 未操作条目的正文与相对顺序不变，新增条目按 add 顺序追加。不支持无条件整库覆盖、按相似文字匹配目标或系统自动淘汰未指定条目。
- 允许一次显式 remove 列出所有当前 IDs；结果可为空。没有绕过 revision 的隐式 clear-all。
- 成功返回新 revision、新增 key→ID 映射及预算摘要，不重复回传完整 M。失败沿用/扩展现有稳定类别 invalid/conflict/occupied/overbudget/unknown-budget/unconfirmed，并给出有界恢复信息；文案不是判断协议。

笔记是 session 工作数据。工具说明提示记录已确认决策、必要理由、当前阻塞/恢复入口，并标明推测与未完成状态；编辑笔记不改变原用户指令或历史事实。不以特定措辞、笔记频率或模型复述作为行为覆盖。关于工具描述与使用指导的进一步优化规范见 [MEMORY-GUIDANCE.md](MEMORY-GUIDANCE.md)。

## 3. 统一提交、并发与持久化

人工 replace/delete 和模型 patch 必须经过同一个 MemorySurface 提交边界，复用现有原生 M-only CustomEntry 与有效 M 投影。UI 现有单条编辑/删除不扩为整套批量编辑器；模型 CRUD 是新入口，底层规则一致。

整批 patch 先形成候选，再一次校验/追加，不出现删除已经生效而新增失败的部分状态。按整批候选计预算，允许显式删除/缩短与新增组合。增长型候选需要预算已知且 fit；减少型候选可以逐步降低超额 M，不要求先让整个主请求低于 H。无变化不追加 entry、不改变有效 M revision、不失效 receipt。沿用既有 session/path/M-head revision 语义：同路径无关消息推进不应产生无意义冲突，路径分叉或真实 M 更新必须冲突。

维护从冻结开始到 Pi 提交成功/失败的原生终态持续互斥；不能在 engine 返回候选时提前解锁，也不排队保存。普通 agent run 不整段锁写。取消发生在提交前不得写入；已经确认提交后如遇取消，不能谎报未写或自动回滚。

保存未确认不得自动重复提交；遵守当前原生会话核对规则，资源 reload 不等于重新读取 session 文件。成功只影响后续新构造请求，已构造/在途请求保持原快照，不 abort/replay。

原生 JSONL 保留完整历史。删除只改变当前 M，不擦除旧 entry、不永久禁止从未来有效证据再次提取同类信息。后续 compaction 冻结当前 M/B/K 并吸收修订；旧人工或模型记录不能覆盖新 checkpoint。resume/tree/fork/new 继续按当前所选路径取得唯一 M。

## 4. 唯一尾部请求布局

主请求逻辑布局：F（含有效系统指令/工具）→ R（真实已交付对话）→ 当前 M。

每次公开 Context 转换读取本次有效 M，识别并移除旧前置记忆载体，然后注入最多一个尾部载体。M 为空时完全不注入。M-only 存储 entry 不进入 R；R 中真实的笔记工具调用/结果仍保留，不能为了缓存删除历史。保持原 R 的顺序、工具调用/结果关联、媒体及实际用户/custom 消息。

尾部是请求局部工作数据，通过公开 Pi 消息转换及原生支持的角色表达，不创造 provider 私有角色。不能直接搬用 compactionSummary 的“此前对话已压缩”历史包装；载体明确说明当前工作记忆及参考性质，不伪装成新的用户请求。它不 append 到会话，也不增加一次 agent turn。相同 M 得到相同载体，不嵌入时间、随机值或 revision。

在 main 请求中，用同一快照完成 F 解析、R/M 划分、计费、receipt 及委托。工具定义继续由宿主提供。不能先按一版 M 检查，后按另一版 M 发出。Current projection、Last main、Slots 与 details 保留各自范围；显示布局应反映当前/实际的 F/R/M 与预算，不在读取报告时写记忆或调用 resolver。

独立 provider 调用和 maintenance 不附加主请求尾 M；maintenance 使用已有 extraction 消息协议中的 M/B/K。共享预算原语不意味着把主请求 carrier 机械搬进维护提示。

## 5. 尾置 receipt 与保守估算

### 5.1 匹配内容

成功请求保存本次模型、有效 F、tools、R 快照、M 快照/估算、对应成功响应、generation 和 payload 绑定状态。R 与 M 从本次投影/请求关联取得，不能通过搜索正文中的 Nunc 字样或把任意末尾消息当作 M。

复用条件：同模型/有效 F/tools；旧 R 是新 R 的未改写前缀；对应成功 assistant 在新 R 中紧随旧 R 的真实响应锚点，身份/content/usage 均匹配；响应成功且 usage 可用，generation/绑定仍有效。不能再用含旧尾 M 的 messageCount 定位响应。若没有唯一有效的本次 R/M 关联，不猜测、不借不匹配 usage。

### 5.2 第一版公式

记 U 为 receipt 对应成功响应报告的上下文 token 总量：旧 input（含 cacheRead/cacheWrite）加旧 output；reasoning 是 output 的组成部分，不另加一次。ΔR 是新 R 中位于该 assistant 锚点之后的消息；T(M) 是当前尾部完整载体的 Nunc 估算，包含包装，空 M 时严格为 0。

**usage-backed 输入估算 = U + estimate(ΔR) + T(当前 M) + 当前明确配置/metadata 的原有额外计费。**

不再次估算锚点 assistant，因为其 output 已在 U 内。不从 U 中扣除启发式旧 M，不重复添加固定 F/tools。继续现有原语对媒体、framing、显式额外输入及 metadata 计费和校验，不改变 output/headroom/硬上限政策。

| 旧 M | 当前 M | 当前 M 项 | 保守余量 |
| --- | --- | --- | --- |
| 空 | 空 | 0 | 无 M 余量，不计不存在的空载体 |
| 空 | 非空 | 完整 T(当前 M) | U 中没有旧 M |
| 非空 | 空 | 0 | U 内保留旧 M 的实际贡献 |
| 非空 | 非空（相同或不同） | 完整 T(当前 M) | U 内保留旧 M 的实际贡献 |

余量只随所选 receipt 保留一次，不递归累积：每次新 receipt 的 U 来自新的实际成功响应，绝不能把上次 Nunc 估算当作新 U。可选用较早仍匹配的 receipt，但必须从它的真实锚点计算完整 ΔR，不能偷换为后来不匹配的低 usage。

没有适用 receipt 时重新估算实际 F/R/M。所有估算仍是 planning heuristic，不承诺 provider tokenizer 硬上界。保守余量在临界容量下可能触发原生 overflow；不能降低检查强度、抬高上限或更改 Pi 软触发线掩盖它。诊断中区分 observed U、估算新增 R、当前 M 与保留旧 M 余量；旧 M 的精确 token 贡献未知，展示只能标注估算，不能伪造实测分项。

### 5.3 失效与并发

仅有效 M 提交（人工或模型）不再无条件清空全部 receipt，也不让仍在途、用旧 M 发出的成功请求仅因 M 更新而丢失建立其真实 receipt 的资格。快照始终记录发送时的旧 M，不在完成时重读当前 M。关联只服务该在途调用，不扩大为跨请求修改缓存。

compaction、路径/session/model 等生命周期按适用规则清空/失配；R 或成功响应改写不能复用。更新模型工具集合会改变 tools，不能借旧工具 F 的 receipt。未知/失败/取消/未发出响应不建立 receipt。

所有非 output 末端 payload 改写继续失去 Context 绑定；增长、媒体/tool/control/output 的既有校验继续。Larva 解析后发生真实变化仍处理，禁止 bridgeCalled 或尾 M 标记绕过验证。entry wrapper/ALS 必须将布局快照、有效 Context、model/signal/模式正确绑定：内层首次透明委托不得重复注入 M 或准入，独立/重复调用不得继承他人的预算。

## 6. 预算与共享状态

M 预算仍由现有模型、F、工具和配置计算，新增工具 schema 本身计入 F。以真实新 carrier 统一计算 M 占用，空 M 没有虚构的 carrier 开销；固定上下文与 M 包装不能分别重复计入。人工、模型、Context 展示及候选规划使用同一计量语义，保留 extraction 的独立来源与输出预算。

写入时使用当前可用预算，预算未知不允许增长；不为取得预算发模型或刷新凭据。Larva 只解析 F，不接触 slot/revision/M 迁移。实际主请求仍使用桥接的本次有效 F 作最终发送检查，写入预算或 Current projection 不冒充已构造主请求的完整 wire 上下文。

## 7. 自动转换，无旧布局运行模式

首次在新实现中读取旧会话时，从当前路径已知 checkpoint 与其后适用修订恢复唯一 M，保留正文、ID、nextId 和排列。能复用现有存储时直接复用，不能仅为位置变化重写 JSONL 或追加迁移 entry。已知完整旧 summary 可按现有来源语义规范化；未知版本、冲突来源或无法区分正文的损坏数据明确失败，不猜测删除。

进入新布局时清空旧布局内存 receipt，首次重新估算，之后只建立新版 R/M receipt。不迁移旧 usage，不接受一次未知解析为成功。首次转换不主动发额外模型请求、不 compact、不动在途请求。

“首次切换”不等于只运行一次 Context 转换：Pi 会从旧 checkpoint 再次生成前置载体，每次新请求仍需幂等识别/转换。不能用 migrationDone 标志放行旧前置 carrier。清空迁移期旧 receipt 的动作不能因此每请求重复触发。新 compaction/恢复后也保持单一尾 M。

只保留新布局；不设置 front/tail 配置，不保留旧布局正常运行或回退模式。历史留存不等于旧版运行兼容。代码可通过 Git 回退保留源变更，但旧程序对新工作状态的可用性没有产品承诺；不能自动改写用户会话来伪造可回退。

这项用户决策只针对 M 格式/布局。Larva v1 零回复 legacy 路径、显式 unavailable/非法/重复拒绝及末端校验继续按 LARVA-PROMPT.md 执行，不能借“无需兼容”取消这些合同。

## 8. 证据、验证与验收范围

现有只读分析：72 小时、5 个明确 Nunc 会话、1476 次成功请求，输入中位数 213525、M 估算中位数 1480、占比中位数 0.67%；整体 cacheRead 90.19%，稳定短间隔 96.2%。25 次 compaction、0 次独立 M 写入。1420 组稳定投影按旧匹配条件前置匹配 1420、尾置匹配 0。固定 F/cache 可用等假设下，尾置的缓存 token 平衡点约 1% 独立修改频率。它们支持设计方向，不是尾置账单、缓存或模型质量实测。可选分析材料 `.scratch/capacity-d778286d/cache-placement-assessment.md` 不构成 clean checkout 的依赖。

本步骤必要证明进入 tracked source/tests/runner；默认 `scripts/check.mjs all` 无需实际 Larva 外仓。至少覆盖：
- 正常开启/关闭工具、宿主真实注册/执行/取消；完整 CRUD、ID/位置、原子失败、revision 分叉与无关前进、无变化不写。
- growth/final-budget、unknown、超额缩减、空 M、人工/模型交错、freeze 至 native terminal、unconfirmed/恢复不重放。
- 实际 Pi Context/serializer 中唯一尾 M、无旧历史包装误用、真实 R/工具/媒体关联与对象不变；空→有→改→空、旧 checkpoint/修订/resume/reload/tree/fork/new、冲突旧数据拒绝、迁移只失效旧 receipt 一次。
- R/assistant 锚点、四类空/非空公式、相同 M、多轮余量不累积、较早 receipt/后来不匹配 usage、响应改写、在途 M 更新和生命周期清理。
- wrapper/prepare-captured/reentry/独立调用、maintenance 隔离、原生 overflow/取消/零传输和末端真实差异仍校验；日志不包含私人正文。
- Slots/current/Last main/details 的新布局、预算、收据来源/余量范围一致；不增加 UI 批量编辑或改变原有编辑器几何的要求。

真实 Larva 组合扩展前置步骤交付的 `tests/pi/larva.integration.ts`，沿用其显式入口和只读 Larva 输入。新合成会话/受控 Provider 验证真实工具→M 变化→尾部请求→成功 receipt；persona 切换/恢复与 M 更新相邻或同时发生、idle callback、reload 和维护终态互斥，保证 F/R/M 属于同一请求状态。测试不能用协议替身替代真实 loader/Larva，也不能把有意脚本化的模型答案视作 agent 记忆质量证明。

最终整合候选需要完整原生 all 和上述扩展组合结果；命令/环境按 DEVELOPMENT.md 和前置步骤声明。复用未变且仍适用的观察，不能用过去删除 worktree 的路径作为当前目标。

离线可以证明结构、角色映射、工具/原生状态行为及计费；载体的数据语义需源/合同审查。自由模型对尾部记忆的实际遵从、长期续做质量、真实缓存/账单收益尚未实测，不伪装成受控服务已证明。真实服务测量需另行授权，不是这次计划隐含的付费检查或新增阻断门槛。历史 CAPACITY 恢复未知原因也不由本功能 PASS 自动解决。

## 9. 实施责任与调度

新增 phase `nunc-active-memory`，依赖 `nunc-larva-prompt`；唯一新实施步骤 `nunc.active-memory`。Node/TypeScript owner 完整交付 CRUD、单一新布局、自动转换、receipt/预算、测试与文档。此依赖是对已接受 F/请求身份桥接结果的消费，不把 M 功能反向塞进其先行接受范围。

只做当前文档/Plan 更新；未来必须有用户明确调度才 claim/dispatch/实施/验证。既有 Larva 调度条件仍有效。测试只用新隔离受控状态，外仓/Larva 只读，不改 Pi、不安装全局扩展、不读日常凭据、不重放历史、不联系真实 peer/启动真实模型子 agent，不发布/push。

Orchestrator 在新步骤完成程序承担最终整合接受：范围是 nunc-active-memory 全部需求、其所依赖的 nunc-larva-prompt F 合同及所有适用的既有 Nunc 核心/原生兼容/维护/人工记忆/报告不变量。前置结果可独立接受，本次追加结果必须在最终候选上具备完整适用检查与真实组合证据。存在阻断缺陷或必要未证明则保持本步骤未完成；不创建重复 gate 或人类等待节点。DONE 历史不可修改。

未完成 owner 原位吸收兼容修复；保留候选和证据，清理自己的受控进程/隔离状态。不自动回退旧布局、删除历史、重放 unconfirmed 操作或改外仓来解除故障。必要外部 Larva 输入不可用时报告缺口，不用更换实际实现或降低验收来通过。
