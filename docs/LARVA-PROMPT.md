# Larva 请求级系统指令桥接

状态：**候选实现已交付并完成 Nunc 独立行为测试与真实 Larva 组合验收，等待 Orchestrator 最终整合接受**。

用户授权本轮根据 Larva 就绪状态调度实施 nunc-larva-prompt phase；全程禁止修改 Pi core、已安装 Pi 包及私有宿主状态。实现仅在每个独立 main 请求准入前通过公开 `pi.events` 发起 `larva:resolve-system-prompt:v1` 同步解析；请求局部有效 Context 统一用于估算、receipt 建立、native Provider 委托与 Last main 观察。零回复走 legacy 路径；explicit unavailable、重复回复或协议错误在传输前由本地 CONFIG 拒绝。maintenance 与 unknown 调用保持零 resolver 请求。真实 Larva 联合验证通过独立入口 `tests/pi/larva.integration.ts` 显式完成。

后续独立交付：[ACTIVE-MEMORY.md](ACTIVE-MEMORY.md) 在本桥接完成后加入主动 CRUD、唯一尾 M 和新的 R/M receipt。它保留本文件 v1 接口及先行步骤的接受范围；M 的自动旧布局转换不会取消这里的零回复 legacy 或显式失败合同。

## 1. 问题、证据与交付边界

当前 `src/pi/admission.ts` 在 Provider Context 上进行主请求容量检查；Larva 可能随后在 `before_provider_request` 修改系统指令。当前 Codex mapper（兼容修复 `79d2904`）允许受限的文本改写并计入增长，但该响应不能为原 Context 建立 usage receipt。

已用当前 Larva 纯函数复现：同 persona 加 continuation 后，后续投影重排受管段落，输入分类发生变化。AurisPi 请求 `d778286d-d921-4316-b238-f3935a2aa6e5` 记录 Nunc fresh estimate 277135、硬上限 271999；离线原会话回放得到 Pi usage estimate 252004，低于默认阈值 255616。原请求没有保留完整 Context、payload delta 或 receipt 拒绝原因，因此当前代码机制与历史归因的证据强度不同。

本次成果是：**在每个主请求的 Nunc 准入边界解析当前 Larva 指令，使估算、receipt 与 Provider 委托使用同一份请求级有效 Context。** Larva 负责当前身份及统一组合；Nunc 不选择 persona、不解析受管标记、不加载或缓存 Larva 状态。Larva 不成为 Nunc 安装或常规离线检查的强制依赖。

Pi 继续独占会话、工具执行、队列、模型/auth/serializer/transport 与压缩调度。此设计不统一 Pi 私有的软阈值估算，不抬高 Nunc 上限、不以软规划线制造新的硬拒绝，不新增调度器、模型工具、注册中心或全局锁。

本次自动压缩未完成的原因仍未证实。原错误可被当前 Pi overflow 分类识别，默认设置下原会话可构成合法压缩切点；这些观察不能证明恢复实际完成。桥接验收不宣称修复全部 CAPACITY 或所有自动恢复问题，不为该独立未知原因新增 Pi 修改任务。

诊断材料是可选线索，位于忽略目录 `.scratch/capacity-d778286d/`；无需重放原会话或重跑调查才能实施。它们不作为未来 clean checkout 的检查依赖。

## 2. 已接收的 Larva v1 合同

依据用户转交的 Larva 设计消息；其源文档位置为 `/Users/tefx/Projects/larva/design/pi-system-prompt-resolution.md`。这是设计依据，不是 Larva 实现就绪或行为 PASS 的证明。以下合同在 Nunc 仓库自包含，不要求产品读取该文档或外仓源码。

事件只通过当前 Pi 运行时的公开 `pi.events` 发送：

```typescript
type ResolveSystemPromptResult =
  | { status: "ok"; systemPrompt: string }
  | { status: "unavailable"; reason: string };

type ResolveSystemPromptRequest = {
  scope: "main";
  systemPrompt: string;
  reply: (result: ResolveSystemPromptResult) => void;
};
```

事件名为 `larva:resolve-system-prompt:v1`。这是进程内同步回调，不是 JSON/RPC/MCP。有效监听器在同一次 emit 调用栈中恰好调用一次 reply；未加载、旧版本或已销毁的 Larva 可以零回复。Pi 的 emit 不等待异步 handler。无 request ID、第二个响应事件、Promise 等待、轮询或跨请求缓存。

`ok` 只表示本次系统指令可确定，空字符串合法。`unavailable` 表示初始化、状态变更、恢复或组合尚不能提供有效指令；不能用旧 prompt 代替。reason 是非空诊断文本，Nunc 不解析其文案决定行为。Larva 回复只代表同步读取时的状态，不冻结后续 persona/mode/continuation 变化。

Larva 对无 persona、过期块清理、损坏边界和 continuation 有效期负责。Nunc 不复制这些规则，不导入 `larva.ts` 或私有类型，不读取 envelope、lease、digest 或 continuation。

## 3. Nunc 消费策略

解析作用域必须沿用现有 main/maintenance/unknown 分类。只有独立进入准入的 main 调用使用桥接；提示词内容、相同模型或空工具不能建立 main 身份。maintenance 与 unknown/独立委托路径不发送事件，也不改变其 Context 或预算绑定。

主请求中先执行适用的取消、模型、原生 Provider 和输入前置验证，再在选择 usage receipt、计算输入和作容量决定之前解析。未提供 systemPrompt 的 Context 以空字符串作为协议输入；实际非法类型不得强制转成字符串。模型/API/auth/output 参数、消息和工具保持原有来源。

| emit 返回时的结果 | Nunc 行为 |
| --- | --- |
| 一次合法 ok | 使用本次字符串构造请求局部有效 Context；即使文本未变也视为已解析 |
| 零回复 | 保留原 Context 和既有 legacy 路径；不等待、不复用以前的结果 |
| 一次合法 unavailable | 本地 CONFIG 拒绝，零 Provider 传输；不静默降级 |
| 同步重复回复，包括两次相同内容 | 协议错误，本地 CONFIG 拒绝；不选第一份或最后一份 |
| 未知 status、必需字段类型错误、空 unavailable reason 等非法回复 | 协议错误，本地 CONFIG 拒绝 |
| 发送桥接请求自身抛出异常 | 协议错误，本地 CONFIG 拒绝，不视作零回复 |

emit 返回时关闭本次接收窗口并固定决定。迟到回复不能改变此次决定、Context、receipt 或后续请求；不能为了检测迟到回复增加等待或定时器。仅迟到回复的调用在同步窗口内仍是零回复。回复字段在本次同步读取中取得，不依赖后来可变的响应对象。

解析失败不得开始 Provider 传输或建立 receipt。取消优先级沿用现有 owned-error/signal 机制；不得把用户取消转换为新的 CONFIG/CAPACITY 恢复。已存在且仍适用的其他 receipt 不因一次解析失败被随意销毁。

## 4. 请求 Context 与 wrapper 调用身份

Pi 0.86.1 的字段迁移见 [system state 合同](PI.md#pi-0861-system-state)：v1 字符串代表完整有效指令。替换通过请求局部的 leading SystemMessage 表达，保留当前工具与真实对话；相同文本保留原 system history。以下 legacy Context 字段描述不要求同时保留 `systemPrompt` 和 SystemMessage，避免重复归一化。

原始传入 Context 及 Pi 全局 systemPrompt、会话消息均不得被原地写回。有效 Context 只替换本次 systemPrompt；其他 Context 字段原样保留，不重新投影消息、不复制 M、不转换 callback 为用户消息，不回填已经冻结的 maintenance 来源。

同一个有效 Context 进入：
- `selectReceipt` 与 `admissionEstimate`；
- `MainSnapshot`、完成响应监听及后续 receipt 匹配；
- 实际 `delegate.streamSimple/stream`；
- 本次 admission 的 Context layout/Last main 观察。

`ctx.getSystemPrompt()` 仍是宿主侧诊断，不能覆盖本次解析值。Current projection 仍表示未发送的宿主投影视图；Last main 表示实际请求视图，两者允许不同，必须保留其范围与时间含义。不得让只读报告浏览为了补数据而调用 resolver 或触发请求。

当前 `CallRecord` 以 Context 对象、model、signal、模式和 wrapper 访问记录识别同一委托调用。替换 Context 后必须维护这个关联，不能让旧 wrapper 因对象变化重复解析、估算或叠加 payload callback。

约束：首个准入负责该逻辑请求的解析；同调用首次访问内层 Nunc wrapper 仍可透明通过；重复访问、持有旧 wrapper 的独立调用、不同 Context/signal/模式的嵌套调用继续触发其原有检查。不能用 prompt 文本相等或 sessionId 单独识别调用。调用内允许记录原 Context 与有效 Context 的关联；它不是跨请求的指令缓存，不能供重试、后续工具请求或 idle callback 复用。

每次新的主模型请求重新解析，包括工具循环、原生重试和 idle callback。没有有效解析的 unknown/maintenance 调用不得借用相邻 main 的关联。实现者决定私有 helper 和 ALS 记录布局，保留现有 Provider 捕获、替换、prepare-captured wrapper 与 teardown 语义。

## 5. receipt、容量与末端校验

只对已委托且成功完成、usage 有效、代际未失效、payload 仍与有效 Context 绑定的响应建立 receipt。后续复用继续要求 model、有效 systemPrompt、tools、消息前缀及响应锚点内容/usage 匹配。系统指令真实变化允许 fresh estimate；不能强迫每次都命中，也不能用旧身份 usage 扣减新身份成本。

桥接不消除 `onPayload` 校验：在解析之后真实 Larva 状态变化、第三方再次改写、追加用户文本或 metadata 增长时，继续按现有 mapper、input/output/media/tool/control 与容量规则处理。非 output 改写继续使该请求不能为前述有效 Context 建立 receipt。禁止 `bridgeCalled`、曾解析标记或 token 跳过末端验证。

保留 `79d2904` 的 main Codex 指令 mapper、last-user append 及保守增长计费；不扩大其他 API 的 wire 改写许可。公开 resolver 本身不依赖 provider API，不新增 Larva 名称/指令内容白名单。

主请求硬上限、memory planning、extraction reserve、uncapped output、metadata/media framing 和原生取消语义不变。正常请求不能因 observer 缺失而多一个拒绝条件；resolver 的明确不可用与协议错误是这里新增的输入确定性拒绝条件。

## 6. 可观察性与隐私

在现有 `AdmissionObservation` 中增加有界解析状态，并通过现有 Last main / details / Diagnostics 数据流提供：`resolved`、`legacy-no-reply`、`unavailable`、`protocol-error`。这是主请求解析事实，不是可缓存的能力发现或会话级状态。maintenance/unknown 不伪报已解析。

保留 estimator、estimateReason、实际 inputLimit 和 payload 分类，使 operator 能区分身份已解析、旧路径、receipt 不匹配与真实容量拒绝。错误文案使用有界安全诊断；不原样回显不可信 reason、完整系统指令、payload、persona 正文、凭据、路径或异常栈。现有本地 Context 浏览能力不扩展为新的持久化日志或网络报告。

## 7. 实施与验证

一个 Nunc implementation owner 交付源码、真实行为测试、必要 tracked 集成入口及文档。没有按 resolver/helper/测试/报告拆分的内部步骤。真实 Larva 联合验证是该步骤的完成条件，不能把仅用协议替身的结果称为根因修复完成。

### Nunc 独立合同测试

纳入现有 `scripts/check.mjs all`：
- 公共 Pi EventBus 同步回复、零回复、显式不可用、重复/非法/迟到回复、嵌套独立解析；不得用会 await handler 的假总线证明同步性。
- 原 Context 不变，有效 Context 确实被估算并传到 native serializer；不是只对 helper 返回值断言。
- 合成稳定指令下连续工具请求取得可匹配 receipt；真实指令变化 fresh，早先适用 anchor 保留，响应内容/usage 重写不能借用 receipt。
- 修改 Context 对象后 wrapper 链只准入一次；不同 Context/signal、旧 wrapper、重复访问、prepare-captured provider、关闭链保留原行为。
- maintenance one-shot 和 unknown 委托零 resolver 调用；主/维护取消、无传输拒绝、failed/unissued 响应不建 receipt。
- 零回复走 legacy，旧 Codex mapper/append/growth/非法输入规则继续工作；显式 unavailable 不走 legacy。
- 解析之后真正的 payload 差异仍校验、计费并失去绑定；观察及只读报告不反向触发解析。

### 真实组合证据

外部输入由用户在 Larva 完成后提供：可运行的 Larva 实现及其声明依赖、适用版本/修订与实施调度指令。仅有设计文件、guard files_checked=0 或 Larva 自报成功不建立联合证明。

计划新增独立的 tracked 入口 `tests/pi/larva.integration.ts`，由 TypeScript 正常编译，经 Node 原生 test runner 显式运行；它不加入默认 `*.test.ts` 库存，避免使 Larva 成为普通 Nunc 构建依赖。入口必须要求显式 `NUNC_LARVA_EXTENSION` 输入，缺失或不可用时非零退出；实际通过 Pi loader 加载该实现，不用协议替身取代 Larva。路径是测试选择参数，不成为产品配置或发现注册中心。

```sh
/usr/bin/env -u NODE_OPTIONS PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  HOME="$PWD/.scratch/offline-home" PI_CODING_AGENT_DIR="$PWD/.scratch/offline-agent" \
  NUNC_LARVA_EXTENSION=/Users/tefx/Projects/larva/contrib/pi-extension/larva.ts \
  /opt/homebrew/bin/node --test dist/tests/pi/larva.integration.js
```

该入口已在候选实现中交付于 `tests/pi/larva.integration.ts`，由同一 writable owner 创建并通过 TypeScript 编译为 `dist/tests/pi/larva.integration.js`。使用新隔离合成会话、persona 测试数据与受控 native Provider；不读日常凭据、不重放原对话、不启动真实模型/子 agent。证明普通请求、连续工具、实际 persona 借用/恢复后 idle callback、continuation 过期、真实 reload/旧实例失效、maintenance 隔离。稳定状态下 Larva 末端不改写目标系统文本，Nunc 建立并复用符合条件的 receipt。真实状态变化后不因旧解析而跳过检查。验证 native serializer 的真实目标文本及受影响支持路径；不能从单个 Codex 成功推导所有 provider。

完整现有离线库存仍要求最终整合候选的 `scripts/check.mjs all`，环境和 baseline 准备按 [DEVELOPMENT.md](DEVELOPMENT.md)。不固定历史测试总数。上述实组合入口补充 all，不能替代它。owner 必须记录实际执行命令、所加载 Larva 版本/修订、目标候选、观测边界、结果和测试进程/隔离状态清理；原始私人 prompt 不进入报告。

受影响 native overflow/取消回归仍保留；联合测试需要明确区分本次接口修复与自动压缩剩余未知。必要协议/身份/receipt/隔离行为有缺陷或未证明时，步骤保持未完成。独立的历史 overflow 原因未知可以如实保留，不扩大为本步骤的 Pi core 修改义务。

## 8. 调度、接受与恢复

待实施 phase：`nunc-larva-prompt`；唯一步骤：`nunc.larva-prompt`。依赖已经完成的 host-prompt compatibility 和 reporting。旧空 phase `pi-host-prompt` 已撤销，无需恢复；所有 DONE 定义、证据和生命周期不可改。

Admission：用户在 Larva 就绪后再次明确调度之前不得 claim、dispatch、开始实施或验证；这不是新建“等人批准”步骤。用户提供实际 Larva 输入后，由 owner 核对它能承担 v1 合同；缺少可用实现时报告依赖缺口，不改 Larva 或 Pi 来补齐。

Orchestrator 在此唯一 implementation 步骤的完成程序承担最终整合接受：本文件全部新增行为，加上依赖的现有 provider/admission/receipt/maintenance/reporting 不变量，最终候选完整 all 及真实 Larva 组合证据均适用，无阻断缺陷或必要未证明项。有效证据可按未变相关输入复用，不重复付费观察。接受不授权发布、push 或全局安装。

当前未完成 owner 原位吸收兼容的 source/tests/docs 修复；停止自己的受控测试进程并保留候选与证据，不动外仓、retained worktrees、日常会话或 settings。运行时失败不授权恢复旧 persona、改预算、主动 compact 或队列重放。采用普通 Git 回退 Nunc 仓库事务，不改 completed history。
