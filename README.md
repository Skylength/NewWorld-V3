# NewWorld V3

以独立 NPC agent 和共同世界环境为核心的文字 RP 项目。本仓库承载新架构与后续实现；NewWorld V1、V2 和 Liyuan 作为设计与代码参考。

## 当前实现

动态区域探索提供本地试玩页和调试控制台：从简短宗门开局，自然语言前往未知地点、调查并丰富区域、改变环境、离开后返回。地点与重要状态自动保存。具体范围和实现见 [动态区域 PRD](docs/project/exploration/PRD.md)、[技术方案](docs/project/exploration/ARCHITECTURE.md)。该功能已实现，待用户试玩验收。

操作示例、实际验证及已知边界见 [区域探索测试报告](docs/project/exploration/TEST_REPORT.md)。已有真实模型样本，待用户试玩验收；最初发现的失败也在报告中保留。

第一个学习切片是“NPC 一次受控回应”：一个指定 NPC 接收观察，通过 Pi agent loop 自主决定是否查询自己范围内的只读记忆，然后返回一段完整回应。它不执行交易、世界动作或记忆写入，也不代表完整 NPC 自主性或多角色世界模拟已经实现。

文档按功能或阶段整理，包含 PRD、技术架构、测试报告和学习文档。当前状态见 [项目入口](docs/project/README.md)，总目录见 [文档目录](docs/README.md)。

开发按 [SOP](docs/project/DEVELOPMENT_SOP.md)执行：讨论需求 → 功能 PRD → 技术架构 → 用户确认 → 开发测试 → 测试报告 → 用户验收 → 学习 → 汇总学习文档。已有首个回应能力的讲解与时序已合并到 [Stage 1 学习文档](docs/project/stage1/LEARNING.md)。

## 本地运行

要求 Node.js >=22.19.0。

    npm install
    npm run typecheck
    Copy-Item .env.example .env

在 .env 中配置 LLM_API_KEY，沿用已有的模型服务地址；使用其他服务时，把 LLM_BASE_URL 设置为其 OpenAI 兼容 API 根地址。区域探索按用户指定的分工默认使用 gpt-6-luna 判断行动与生成结构，使用 gpt-6.1-sol 生成玩家看到的叙述；NPC 回应也使用文本路由。可分别用 LLM_STRUCTURE_MODEL 和 LLM_TEXT_MODEL 覆盖这两个默认值。各入口通过统一角色路由取模型，旧 LLM_MODEL 不再决定这些入口的模型。缺少凭据时不会发送请求。

    npm run explore

本次已启动的调试工作台为 http://127.0.0.1:4320/#debug，试玩为 http://127.0.0.1:4320/#play。工作台连接现有 4319 世界服务，共用 `data/exploration-routed/` 存档与 sol/luna 路由。需要重启同一试玩时先执行 `npm run explore -- --port 4319 --data data/exploration-routed`，再执行 `npm run console`。默认 explore 命令仍使用 4318 与 `data/exploration/`，新启动时也直接提供完整工作台。

可用 `npm run explore -- --port 4319 --data data/exploration` 更改端口或存档目录。调试工作台支持运行筛选与固定、阶段链路、模型耗时时间条、上下文字符组成和区域变化对照；右侧按需查看原始证据，当前世界与历史记录分开。每次行动最多两次模型请求，整轮共用 120 秒超时，无隐藏重试；结构和叙述都成功后一起保存，任一阶段失败或取消都不提交半轮结果。存档只保存在本地，关闭后世界暂停，创建新世界不会删除旧存档；旧的单阶段历史记录仍可查看。

    npm run demo -- --scenario recall-needed --trace
    npm run demo -- --scenario already-known
    npm run demo -- --scenario unknown

也可用 --observation "..." 覆盖场景观察。--trace 输出实际送入模型的上下文、工具声明、工具参数、工具回执和回应片段；日志会省略模型思维过程与凭据。trace 可能包含角色和记忆内容，只应在本地查看。

三个固定场景分别覆盖：记忆中有答案但上下文未提供、当前上下文已包含答案、NPC 私人记忆中没有答案。

## 自动验收

    npm run check
    npm run acceptance -- --mode scripted --trials 2
    npm run acceptance -- --mode live --trials 3
    npm run acceptance:exploration -- --mode scripted
    npm run acceptance:exploration -- --mode live

check 一次执行类型检查、工程测试和 scripted 场景，无需 API key。scripted 模式经过真实 Pi loop，验证程序机制，语义评分会标为 skipped。

live 模式使用真实角色模型与裁判模型，先做硬性检查，再按场景标准进行语义评分；每次 trial 独立初始化，保留全部失败。角色默认使用文本路由 sol，裁判默认使用结构路由 luna；可用 ACCEPTANCE_JUDGE_MODEL 单独覆盖裁判模型。裁判 key/base URL 可分别配置，默认复用已有凭据和端点。操作方法和历史结果统一见 [Stage 1 测试报告](docs/project/stage1/TEST_REPORT.md)。

报告位于 reports/acceptance/，包含状态、逐项判定、请求与工具轨迹、裁判证据和每个场景的通过次数。功能失败退出 1，执行或裁判错误退出 2。

GitHub workflow 对相关 push/PR 自动运行工程检查和 scripted 场景；配置仓库模型凭据、模型变量和 LIVE_ACCEPTANCE_ENABLED 后，自动运行 live 验收。目前 workflow 仅在本地写入，尚未在 GitHub 执行。

## 阶段状态

当前主线为 **Stage 1：让 NPC 活起来**。通用角色能力的方向已确认，技术架构 v0.1 已形成可审阅方案；确认具体实施范围、方案与测试场景后进入开发。MVP 用于组合验收。

NPC 主线已有获用户确认的受控回应能力；完整独立角色的动作、通信投递和后续唤醒尚未实现。区域探索是单独的世界生成与更新切片，不能替代 NPC 主线验收。需求与完成条件见 [功能 PRD](docs/project/stage1/PRD.md)，现行实现与待定方案见 [架构设计](docs/project/stage1/ARCHITECTURE.md)，真实模型质量遗留项保留在测试报告中。
