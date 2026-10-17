# Stage 1 测试与验收报告

更新：2026-10-13。当前验收对象是“指定 NPC 收到观察 → 按需查询自己的记忆 → 完整回应”。

2026-10-15 配置更新：用户指定文本默认 gpt-6.1-sol、判断/结构默认 gpt-6-luna。当前 CLI 通过统一路由加载默认角色模型与裁判模型；可分别用 LLM_TEXT_MODEL、LLM_STRUCTURE_MODEL、ACCEPTANCE_JUDGE_MODEL 覆盖。下文保留 10 月 13 日历史执行配置与结果，不据此追认新的真实 NPC 验收。

用户已确认这一首个原子能力完成；完整 Stage 1“让 NPC 活起来”仍在进行中。通信送达、世界行动、新经历形成、后续唤醒与持续自主行为尚未交付。阶段目标见 [功能 PRD](PRD.md)，实现边界见 [架构设计](ARCHITECTURE.md)。自动判定与用户验收分别记录，后续功能在开发测试后补充实际报告并提交用户验收。

首片完成的用户确认不覆盖历史自动结果：首次有效 live 套件为 **8 PASS / 1 FAIL / 0 ERROR**，另一次不可用模型尝试为 **9 ERROR**。语义质量与裁判校准仍有待办。

## 1. 验收范围与证据等级

| 入口 | 验证内容 | 模型 API |
| --- | --- | --- |
| `npm test` | 真实 Pi loop 接线、作用域、取消、预算、异常、裁判契约与本地 HTTP 集成 | 不需要 |
| `acceptance --mode scripted` | 固定场景的硬性检查、独立重复 trial、轨迹与报告 | 不需要 |
| `acceptance --mode live` | 真实角色模型执行、硬性检查、真实模型语义裁判 | 需要 |

scripted 的 PASS 标为 `mechanism-only`，语义检查为 `skipped`。本地 HTTP 替身及测试中注入的 live 分支只能证明接线；它们都不能证明真实角色表现。语义裁判仅用于验收，当前产品回应链路没有逐轮裁判。

场景定义位于 [npc-reply.json](../../../acceptance/npc-reply.json)，共享数据位于 [npc-scenarios.ts](../../../fixtures/npc-scenarios.ts)。演示和验收共用定义，每个 trial 独立初始化。当前记忆为预置数据；验收不包含交易执行、记忆写入或世界时间推进。

## 2. 三个场景与判定边界

| 场景 | 初始条件 | 可观察的成功条件 |
| --- | --- | --- |
| `recall-needed` | 药师刚拒售；具体留药约定只在其私人记忆，可见信息仅提供主题索引 | 实际查询到约定后用它解释拒售；不补写无依据的事实 |
| `already-known` | 留药原因已在当前可见上下文 | 依据已知事实完整回应；直接回应或查询都合法 |
| `unknown` | 本角色的上下文和记忆均无该约定，独特秘密放在其他角色或世界 | 表达信息不足、询问或给出不依赖该事实的回应；不能说出越权秘密 |

允许同义表达、拒绝、犹豫和不同合理回应，不要求固定对白或每次调用 `recall`。回应应体现角色目标与处境，并保留玩家控制权，不能替玩家决定接受、愤怒或付款。

使用首次有效输出，保留失败与执行错误；不反复生成挑选满意样本。新增行为时补充 fixture、成功条件、相关硬性检查和场景。真实失败可收为后续回归样本。

## 3. 硬性检查、语义裁判与成本

实际入口为 `examples/acceptance.ts → loadSuite → runAcceptance → runActorReply → Pi Agent → 硬性检查 → 可选裁判 → 报告`。替身只注入 `PiModelRuntime` 模型边界，工具解析、执行和回执仍经过真实 Pi loop。

[checks.ts](../../../src/acceptance/checks.ts) 检查完整回应、fixture 未变更、真实记忆访问作用域与回执来源、预置秘密泄漏、初始请求未预塞私人记忆、调用预算、终止事件和 trace 元数据。秘密文本检测只覆盖 fixture 声明的文本或标记；任意语义泄漏仍需结合场景判断。

确定性测试覆盖以下边界：

- 同世界不同角色、不同世界相同角色或记忆 ID 均不能串线；工具附带身份参数不能改变宿主绑定范围。
- 直接回应、查询后回应、无命中、查询失败与非法参数均有明确结果；只读查询不修改 fixture。
- 模型或工具执行中取消返回 `aborted`；迟到结果不能改成完成，终止事件恰好一次，监听与计时器释放。
- 超时能结束对忽略取消信号的角色仓库的等待；持续工具调用在下一次超限调用前结束。
- 无效作用域在模型请求前失败；部分流式输出后的模型错误不提交完整回应。

仅硬性检查全部通过时，live 才请求语义裁判。裁判仅接收目标、可见事实、实际 recall 回执、观察和最终回复，不读取模型内部思维。它必须覆盖全部标准并引用真实 evidence ID；无效 JSON、漏项和伪造引用为 ERROR，不能覆盖硬性失败。

[runner.ts](../../../src/acceptance/runner.ts) 默认每次角色运行最多 **4 次模型请求、3 次工具执行、120 秒**，由程序强制执行。[judge.ts](../../../src/acceptance/judge.ts) 每个合格 trial 最多发起一次裁判请求，配置 60 秒超时、4096 输出 token 上限和零重试。

默认三场景各三次最多发起 36 次角色请求及 9 次裁判请求；这是调用数量上限，不是金额上限，也不包含额外的接口探测。应先筛选相关场景并确定 trial 数量；当前没有整套验收的货币预算门禁或历史成本基线。

## 4. 运行、配置与报告

在项目根目录使用 Node.js `>=22.19.0`，首次安装执行 `npm ci`。依赖固定为 pi-agent-core / pi-ai 1.1.0。

```bash
npm run typecheck
npm test
npm run check
npm run acceptance -- --list
npm run acceptance -- --mode scripted --trials 2
npm run acceptance -- --mode live --trials 3
npm run acceptance -- --mode live --scenario unknown --trials 3
```

`npm run check` 组合类型检查、工程测试和 scripted 场景，不调用真实模型。CLI 默认 scripted；默认每场景次数为 scripted 1 次、live 3 次，`--trials` 接受 1–20。可用 `--tag memory`、`--suite` 和 `--output` 筛选能力、指定清单及报告位置。失败不自动重试。

live 从 `.env` 或进程环境读取 `LLM_API_KEY`、`LLM_MODEL` 和明确指定的 `ACCEPTANCE_JUDGE_MODEL`。`LLM_BASE_URL` 支持兼容端点；裁判可另配 `ACCEPTANCE_JUDGE_API_KEY`、`ACCEPTANCE_JUDGE_BASE_URL`，缺省复用角色凭据和端点。参考 [.env.example](../../../.env.example)；缺少必要配置时在任何请求前退出 ERROR。

Ctrl+C 传递取消信号。中断、模型执行错误和裁判协议错误均记为 ERROR；已完成 trial 立即落盘，不因后续失败而抹掉其结果。报告保存情况应以实际生成文件为准。

| 状态 | 含义 | 退出码 |
| --- | --- | --- |
| PASS | 当前模式覆盖的检查全部通过 | 0 |
| FAIL | 硬性或语义约束未满足，包括运行预算耗尽 | 1 |
| ERROR | 模型、网络、裁判协议错误或评估中断 | 2 |

套件中 ERROR 优先于 FAIL；裁判错误仍保留已完成的硬性检查。当前门禁只要存在 FAIL / ERROR 就非零退出。多次 trial 的通过率是观察值，未实现统计显著性或历史基线自动比较。

产物位于 `reports/acceptance/<时间与随机 ID>/`：每个 trial 有 `trial.json`、`trace.ndjson`、`report.md`；调用裁判时另有 `judge_packet.json`、`judge_response.txt`。套件有 `summary.json`、`summary.md`，保存状态计数、模型、Node/Pi 版本、场景与 prompt 摘要、预算及 Git revision。

真实 `.env` 和 `reports/` 均被 Git 忽略。报告会替换配置的 API key，凭据不得写入正文或提交。原始报告链接仅在保留了本地产物的工作区可用。

## 5. CI 使用说明

[acceptance.yml](../../../.github/workflows/acceptance.yml) 在相关源码、fixture、场景、依赖、测试或 workflow 的 push/PR 上运行类型检查、工程测试与 scripted 验收，并上传产物。

- 自动 live：配置 `secrets.LLM_API_KEY`、`vars.LLM_MODEL`、`vars.ACCEPTANCE_JUDGE_MODEL`，按需配置独立裁判 key / base URL；设置 `vars.LIVE_ACCEPTANCE_ENABLED=true` 后，相关 push 与同仓库 PR 运行 live。
- 手动 live：`workflow_dispatch` 明确选择 `live=true`；选择 false 不调用真实模型。可指定每场景次数。
- fork PR 不自动取得真实凭据。workflow 已写入仓库，历史记录中尚无 GitHub 实际执行证据。

## 6. 已执行验证记录

### 2026-10-10：首片实现

类型检查通过，真实 Pi Agent、只读 recall 与 CLI 三场景实现。当天尚未执行真实模型或确定性自动验收；该历史状态已被后续记录推进，不能据此把示例本身当作通过证据。

### 2026-10-12：确定性与协议验证

- `npm run check` 通过；39 项工程测试通过；三个 scripted 场景各两次，6/6 PASS。
- 本地兼容 HTTP 服务覆盖“角色请求 → recall 回执 → 第二次角色请求 → 裁判”的完整接线；HTTP 500 只发起一次请求，无隐式重试。
- 测试发现并修复 Pi 参数转换可能把小数归一成整数的问题，宿主改为校验原始参数。
- 测试发现工具取消后 Pi 仍可能尝试下一次请求，现由模型边界拦截；终止后拒绝迟到事件。总超时覆盖忽略取消的仓库等待。

这些结果证明机制约束；真实角色行为证据见下述独立记录。

### 2026-10-12：首次真实模型验证

用户提供兼容端点；`/v1/models` 返回 200。本地 `.env` 配置角色 `gpt-6-luna`、裁判 `gpt-6.1-sol`，裁判复用角色端点与凭据；两者分别通过一次简短实际调用后运行套件。

此前选择目录中的 `gpt-5.4-mini / gpt-5.4` 时，角色请求全部返回 400，后端提示账户不支持 `gpt-5.4-mini`：**三个场景各三个 trial，共 9 ERROR，裁判未调用**。这不是角色行为失败或通过；目录列出不保证账户可调用。[该轮原始汇总](../../../reports/acceptance/2026-10-12T03-31-19-841Z_47e0492a/summary.md) 保留全部错误。

可用模型的正式套件执行 `npm run acceptance -- --mode live --trials 3`。环境为 Node v22.19.0、Pi 两包 1.1.0；每次独立初始化，未修改 prompt、fixture 或标准，也未挑选重生成结果。

| 场景 | trial 1 | trial 2 | trial 3 | 实际角色路径 |
| --- | --- | --- | --- | --- |
| recall-needed | PASS | FAIL | PASS | 每次自主 recall 一次，均命中留药约定后回应 |
| already-known | PASS | PASS | PASS | 三次均直接依据已知事实回应，无 recall |
| unknown | PASS | PASS | PASS | 每次 recall 一次，空结果后承认不确定 |
| 合计 | 3 PASS | 2 PASS / 1 FAIL | 3 PASS | 9 次均完成且全部硬性检查通过 |

总计 **8 PASS / 1 FAIL / 0 ERROR**，套件因语义 FAIL 非零退出。完整 [summary.md](../../../reports/acceptance/2026-10-12T03-32-05-010Z_bf12b5e0/summary.md) 及各 trial 保存回复、轨迹、裁判输入、原始输出和逐项判定。

`recall-needed` trial 2 将“给孩子留退烧药”写成“留给他发烧的孩子”。记忆未明确病情，该场景 grounded 标准明确禁止补写病情，故为 FAIL；查询约定和玩家控制权检查仍通过。见 [失败报告](../../../reports/acceptance/2026-10-12T03-32-05-010Z_bf12b5e0/recall-needed/trial-2/report.md)。

复核发现 `already-known` trial 1 也写“发烧的孩子”、trial 3 写“生病的孩子”，裁判仍判 PASS；trial 1 的理由是病情符合退烧药语境。两场景 grounded 标准不完全一致，后者未明确列出病情。因此 8/9 是原始自动结果，不能等同于人工复核确认八次都没有事实补写。

本次未改标准、prompt 或原始判定。真实 Pi 工具循环、按需回忆及空回执后的不确定回应已得到运行证据，语义质量仍需校准。配置及文档更新后再次 `npm run check` 通过：类型检查、39 项测试与三个 scripted 场景通过；凭据扫描未在报告发现配置的 API key。

### 2026-10-13：用户确认与文档验证

用户确认首个受控回应原子能力完成，细节补写保留为后续质量优化；完整 Stage 1 和 MVP 未完成，历史 live 结果未改判。

当天原型回归执行 `npm run check`：类型检查、39 项工程测试与三个 scripted 场景通过。之后的 NPC 设计、SOP 及阶段文档整理仅检查文档一致性，不计作新的工程或真实模型验收。

文档整理不改变上述判定，原始运行产物继续保存在 `reports/acceptance/`。完整 Stage 1 尚未验收；新的功能范围和方案确认按项目 SOP 执行。

## 7. 待验证与质量项

- 统一事实、合理推测与确定表述的边界，用已保存失败及裁判不一致样本校准标准；若改判，应新增复核记录并保留原结果。
- 明确下一切片行为与预算后补充验收，不用本首片结果宣布消息送达、世界行动、持续记忆或自主生活完成。
- 当前关键词记忆匹配只适合内存样例；尚无产品级检索质量、长程角色稳定性、统计回归或真实 GitHub workflow 运行证据。

首个受控回应能力的既有学习材料已合并到 [学习文档](LEARNING.md)。后续功能在用户验收后开展实际学习，再汇总相应内容。
