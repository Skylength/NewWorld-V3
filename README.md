# NewWorld V3

更新：2026-11-06。当前工作树为 `feat/director-core`（HEAD `1bd761c`，包含未提交的试玩初始化/页面调整）。这是本地文字RP原型：Director提出场景变化，独立NPC按需选择，程序推进时间并保存后果。

## 当前代码与技术入口

- [现行框架与世界区域架构](docs/project/exploration/ARCHITECTURE.md)：模块依赖、数据所有权、完整回合、API、模型调度、上下文、提交/恢复及扩展边界。
- [NPC Core现行实现](docs/project/stage1/ARCHITECTURE.md#现行-npc-core-实现)：身份、经历、能力、计划、通信与时间调度。
- [文档目录](docs/README.md)与[项目入口](docs/project/README.md)：需求、设计和历史证据的分类导航。

当前支持自由输入探索/交谈、区域创建与返访、地图固定目标迁移、人物创建及启用、计划与通信、事件记忆、存档及调试。主输入的interact允许按明确行动移动，不再锁定当前位置。

当前初始化为青云宗前庭、女性掌门沈清和；玩家前来拜师但尚未入门。掌门预先启用独立能力，初始化不发模型请求；旧存档保留自身状态。前端已有人物面板；背包/技能尚未提供完整玩法。

## 本地运行

Node.js >=22.19.0，安装依赖并配置环境：

    npm install
    Copy-Item .env.example .env
    npm run explore -- --port 4341 --data data/director-core

启动后访问 http://127.0.0.1:4341/#play，调试页为 /#debug。不带参数的explore实际默认是4318端口和data/exploration。不同服务/分支必须使用不同存档目录，单进程互斥不提供跨进程同写保护。

.env配置LLM_API_KEY、可选LLM_BASE_URL；结构模型默认gpt-6-luna，文本/NPC默认gpt-6.1-sol，分别用LLM_STRUCTURE_MODEL和LLM_TEXT_MODEL覆盖。配置在启动时读取。模型缺配置时可查看世界，需推理的操作会拒绝。

可独立启动页面代理，仍使用同一个世界服务：

    npm run console -- --port 4342 --api http://127.0.0.1:4341

console代码默认端口4320、上游http://127.0.0.1:4319；这是独立入口的默认值，不会自动寻找explore进程。

## 执行与数据边界

- 主聊天/地图经过Director结构、NPC按需推进和最终叙述，共用120秒；两个世界阶段各最多1请求，NPC最多6次激活且每次最多2请求，组合上限14次。没有NPC决策时才是2次。
- 人物面板交谈、等待和继续直接进入NPC Runtime，不经过Director/叙述；每段180秒，最多6次激活、每人2次。到预算暂停后可继续或停止。
- 世界时间由行动/等待推进；阅读、页面轮询、现实时间经过和关闭应用不推进世界。
- 主聊天失败/取消不提交候选世界；人物面板保留已提交进度。存档是本机JSON原子快照，新建世界不删除旧世界。
- “记住此人”弹窗与取消关注调用track，零模型请求；“启用独立行动”单独调用promote，两者互不替代。
- /api/state和导出包含完整世界与私人调试信息，服务定位为本机单用户工具。

原受控回应演示仍可使用：

    npm run demo -- --scenario recall-needed --trace
    npm run demo -- --scenario already-known
    npm run demo -- --scenario unknown

它走src/actors，只读回忆和回应，不修改当前探索世界；不要把该演示与完整NPC Runtime混为一条链。trace含角色/记忆数据，仅作为本地调试资料。

## 人物形成实施与验证状态

[游玩中人物形成PRD](docs/project/stage1/PRD.md#游玩中人物形成与长期交往-v01)已授权开发，[技术文档](docs/project/stage1/ARCHITECTURE.md#游玩中人物形成与长期交往-v01)已按2026-11-11代码整理。轻量身份、来源化增量、关注、约定、摘要和主输入幂等已接入，本轮自测通过、待用户试玩验收。存档保持v1可选字段兼容，没有执行原提案的v2迁移；开局创建不在本增量范围。

Director初版的12次操作/24次真实请求见[联合报告](docs/project/exploration/TEST_REPORT.md)。本次人物形成已完成42次操作/85次真实请求，原始失败和剩余验收项见[NPC报告](docs/project/stage1/TEST_REPORT.md)。本轮自测通过；未提交、未部署，待用户试玩验收。

    npm run check

check仅做类型检查，不调用真实模型。禁止新增、修改或生成测试文件，既有运行入口和人工试玩用于行为验证；完整约束见[AGENTS.md](AGENTS.md)，流程见[开发SOP](docs/project/DEVELOPMENT_SOP.md)。历史报告中的旧测试命令/CI已不属于当前工程。
