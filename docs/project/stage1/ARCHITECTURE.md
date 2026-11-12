# NPC Core 技术架构

更新：2026-11-11。依据 `feat/director-core` 当前未提交工作树整理；已授权开发，**本轮自测通过，待用户试玩验收**。需求以[PRD](PRD.md)的IC/AC为准，实际证据、原始失败和剩余项见[测试报告](TEST_REPORT.md)。框架与区域协议见[世界架构](../exploration/ARCHITECTURE.md)。本文说明实际代码，不把原提案类型当成已实现接口。

## 现行 NPC Core 实现

### 模块与所有权

| 模块 | 职责 |
| --- | --- |
| src/exploration/service.ts | 单写入者、命令去重、候选回合、预算、提交及摘要维护 |
| src/director/protocol.ts | 玩家发言引用、普通人物具名对白、观察和阶段划分 |
| src/npc/state.ts | 建档、关注、运行模式、事件/经历与玩家投影 |
| src/npc/identity.ts | 宿主ID绑定、姓名/别称/简介更新和来源历史 |
| src/npc/profile.ts | 版本化资料增加与明确修订 |
| src/npc/portrayal.ts | 普通人物认知更新，复用独立人物的认知校验 |
| src/npc/commitments.ts | 请求/承诺/结果、来源和按知情版本投影 |
| src/npc/context.ts、decision.ts | 共享经历、自有上下文及Pi只读工具循环 |
| src/npc/engine.ts、runtime.ts | 能力、计划、到期事件、按需决策和检查点 |
| src/memory/summaries.ts | 有来源摘要、阈值、视角和失效签名 |
| src/npc/recovery.ts | 新增资料、事项与引用的恢复检查 |
| src/exploration/store.ts | 完整JSON快照、fsync和原子替换 |

不是每项功能一个Agent。Director每个主回合做一次结构判断，叙述模型生成正文；只有mode=agent的人物运行自己的Pi决策。关注、分配ID、校验、时间推进和存档由程序执行。

### 数据与身份

ExplorationWorld.npc仍为version=1，包含actors、events、letters、runs、advance、receipts及可选playerAttention/commitments。人物始终使用同一ID；background和agent仅表示运行方式。

轻量创建允许name=null搭配displayLabel，描述/性格/目标可空。内部name保存显示称呼，nameKnown=false表示公开姓名尚未确定。Director新人物ID是本轮引用，宿主生成UUID并替换结构中的引用；已有ID不能重建。

只按ID强制唯一。同名、同地、同职务不证明同一人；aliases的text/scopeId及目录帮助模型结合归属和交往判断。歧义应澄清，不自动合并。程序不提供通用语义共指证明，语言质量仍须验明。

人物还保存persona、goals、condition、inventory、experiences、beliefs、relations、knownLocations、contacts、plan、wakeAt、pending。原persona作为自有背景保留；新增事实进入profile，不每轮重写整个人物卡。

### 事件、知情与运行

事件保存ID、世界分钟、actorId、kind、text、witnesses，实际发言另存speech:{targetId,text}。本人能力执行完成的行动可标completedAction。经历由事件投递生成，不从最终正文再抽取另一套事实。

目前同地点即视为可听见，未实现耳语/距离/遮挡。发言主动唤醒目标，旁观者获得经历但不必然插话。Director不能代写独立人物的选择、承诺、移动或资源后果。

信念与单向关系须引用本人真实经历，关系目标还须是联系人。数值表示当前理解，不自动建立双向契约或玩家感情。普通人物同样保留认知，关注/启用不重置关系。

调度使用pending、wakeAt、计划dueAt、信件dueAt及约定dueAt；无事件区间跳时刻，无现实时间离线补算。当前按人物数组顺序串行选择pending人物，没有公平队列或多人并行。

同一时刻先结算已到期计划及预约，再处理约定到期提醒，避免提醒打断本应已完成的工作。随后处理通信送达；是否履约仍须引用实际完成事件，提醒本身不能代替成功结果。

能力注册表提供validate/duration/execute：move到已知地点（首版10分钟）；work个人活动（1–1440分钟，不生成人物资源）；send信件/同地传音；give交付实际持有物品。信件30分钟后检查地址，传音同地即时。计划最多五步，可被消息打断，保留已完成后果；没有部分工作进度恢复。

## 游玩中人物形成与长期交往 v0.1

### 关注与公开身份

POST /api/npcs的kind=track接受worldId、baseRevision、commandId、npcId、tracked。目标须已接触或在场。界面弹窗提供“记住此人/暂不记住”，取消关注直接操作；不提供自然语言attentionChanges。

关注只维护唯一ID集合，零请求、零世界时间，不补全人生、不启用独立运行、不增加关系。promote另为“启用独立行动”。既有表单创建兼容保留，不扩展开局创建。

顶层identityChanges每项为npcId、expectedRevision、name、alias、scopeId、sourceKind、sourceText及可选description。来源为本轮玩家明确设定，或本人实际说出且玩家听见的对白片段。姓名/别称须在来源中出现；新的自述不能覆盖已有确定姓名。更新保留ID、旧别称及identityHistory。隐藏真名归私有profile，不通过此接口公开。

### 来源化资料与认知

顶层profileChanges每项为npcId、expectedRevision、topic、text、sourceKind、reference、supersedesId。player_setting引用本轮明确创作原文，问句/假设不能当设定；world_creation使用current_turn并由宿主保存回合ID，只补未知内容；executed_event引用本人接触的实际action事件，不能将自述当事实。

事实保存宿主ID、来源、active/superseded状态和修订链。同主题不能并存矛盾有效版本；修订须引用旧事实，普通创作不能覆盖已成立事实。批次在暂存副本校验后应用，同批使用初始profile revision。任意自然语言之间的逻辑冲突仍由模型解释，程序只保证身份、版本、来源与修订规则。

顶层portrayalChanges为npcId、beliefs、relations，只更新当前场景普通人物，复用commitCognition校验；独立人物通过自身决策更新。一次行为保留为经历，不自动固化人格。

普通人物认知可引用已有经历ID；本轮新交谈尚未分配ID时，可用current_interaction/current_reply，宿主分别绑定本阶段实际投递给本人的玩家speech及本人speech，且须本人见证。解析前后阶段分别执行，不能引用未来或上阶段冒充本阶段的发言。缺少对应事件时拒绝；旧经历引用仍须在语义上支持判断，合法ID本身不证明内容相关。

### 具名交往与约定

director.interactions引用玩家原输入，director.speeches保存普通人物实际对白，director.observations保存最终场景可感知变化。interactions/speeches可带phase=start/arrival，createNpcs可带appearance=start/arrival；省略时按人物当前是否在场判断。

顶层及独立决策的commitments每项为id、expectedRevision、ownerId、targetId、text、dueAt、status、sourceText、eventId。新事项id=null、revision=0。requested要求请求方真实发言，open要求履行方真实承诺；fulfilled须引用履行方completedAction事件，不能只凭自述或时间经过；cancelled要求本人取消对白。终态不可重写，参与者不可换人。

事项保存来源事件、解决事件、见证人和逐版本历史。查看者只读自己接触过的最后版本，私下取消不直接泄漏。到期将open改为overdue并通知独立人物，不宣称履行，不使普通人物自动后台行动。

### 主回合提交链

1. 校验命令/版本，保存run及幂等回执，装配上下文并调用结构模型。
2. 解析草稿、绑定新ID、在克隆中预检区域和下一轮必要上下文容量。
3. 候选中创建start人物、应用资料、投递开始交谈/对白、认知和已有真实发言依据的事项。
4. 推进世界时间，处理计划、通信、到期事项及独立选择；前后阶段共享NPC预算。
5. 应用区域/位置、arrival人物和剩余资料，投递抵达观察/交谈/对白及事项，再处理当前时刻独立反应。
6. 应用剩余普通认知和公开身份变化，向文本模型提供玩家可见真实结果并生成正文。
7. 最终容量检查后原子保存整轮；失败/取消保留实际请求记录，不保留候选人物、事实、事件或时间。
8. 提交后剩余预算允许时维护至多一份摘要，失败不撤销游玩结果。

开始承诺在时间推进前进入候选，所以同轮等待能触发到期。相互依赖的多人来回交锋仍分回合，不预写独立人物尚未发生的选择。

人物面板采用检查点语义：操作先保存，advance逐检查点推进，失败/取消保留已完成进度并暂停，可continue/stop；与主回合整轮回滚不同。

### 上下文与摘要

普通人物只装配当前场景人物，包含身份、关注、selfNotes、共同经历、相关认知和共享摘要。selfNotes仅为本人设定，不等于玩家/其他人知情；正文只取公开结果。共享经历按玩家见证事件过滤。独立人物使用自己的profile、状态、关系、事项、经历和已知环境；recall/inspect身份与世界由宿主固定。

共同选择函数取最近12条及最多5条相关旧经历，原始事件不删除。事项按查看者投影独立装配，不靠摘要保存。所有在场普通人物当前均进入结构上下文，没有任意规模的自动重点裁剪；超限明确拒绝。

摘要只维护已关注人物：新增20条经历或6000字符时才候选，单次事件材料最多8000字符，总提示最多12000字符，输出最多1200 tokens/2400字符。普通人物使用shared，独立人物使用self；结合旧摘要及引用递进更新，保留原始资料。

签名含mode、身份/资料revision、信念和关系；变化使旧缓存失效。摘要保留audience、signature、text、evidenceIds和覆盖水位，引用必须来自材料。失败保存水位，不自动重试同水位。新操作可打断维护，迟到缓存不得覆盖新状态；恢复丢弃无效缓存，不清空原始经历。

维护复用npc.runs，kind=summary，保存实际模型/上下文、输出、次数/token、时间与错误。新操作克隆世界后只更新对应运行记录，不回写旧缓存。最近100条运行记录上限不作用于人物经历。

### 预算与模型调用

| 路径 | 当前约束 |
| --- | --- |
| 主回合 | 结构一次、正文一次，NPC按需；120秒/最多14请求，含维护 |
| 独立决策 | 最多2请求/3只读工具/60秒；初始上下文22000字符，请求上下文32000字符 |
| NPC推进 | 最多6次激活/每人2次/100次程序推进；面板180秒、最多12请求 |
| 摘要 | 每操作最多1请求/20秒，占剩余请求和时间 |
| 世界模型 | 单次提示最多24000字符；提交前下一轮必要上下文最多20000字符 |
| 人物 | 最多100人、12个独立人物；关注不占独立运行名额 |

沿用结构/摘要luna、正文/独立NPC sol，配置可覆盖。没有每轮语义裁判、自动JSON修复、静默重试或额外人物生成请求。预算不足拒绝主回合或暂停面板推进，不删除关键事实伪装成功。

NPC工具预算一旦阻断，streamFn也拒绝后续provider调用；不能在工具已超限后再消耗一次请求才结束。请求次数在实际模型边界计数，工具次数在执行前计数。

### 幂等、存档与兼容

主输入/地图支持commandId/worldId/baseRevision，正式客户端提供完整参数。接受时保存规范化指纹及runId，同ID同参数返回原run，同ID异参数拒绝；失败后相同ID也不重新调用。旧调用者不传commandId时不保证重发去重。人物面板沿用独立回执。

主回合在模型边界预占请求计数后立即落盘，再发送请求。恢复将running主run/call及NPC运行标failed，不自动重试；面板未结束advance标paused。响应未到时token用量可能未知。仍是本地单写入者JSON原子替换，不支持多服务同时写同目录。

保留world schemaVersion=1和npc version=1，新增字段可选；缺字段按旧语义解释，旧ID、事件、方案和persona不批量重写。恢复校验新增身份、关注、事实链和事项引用。原提案中的v2批量迁移、legacy事实转换及历史事件seq重编号未采用，避免无必要的数据转换；不能声称实现了v2迁移。未知版本拒绝载入。

完整世界和请求证据用于本机调试/导出；玩家面板用playerNpcView过滤，不展示私有目标、关系或异地经历。这不是多租户权限隔离服务。

### 验证与剩余边界

真实长链累计30次操作/57次请求，包含23成功主回合、2失败主回合以及关注/独立启用/通信，失败与复核分别保留。原批次30操作/90请求预算已到操作上限；2026-11-11用户随后明确不限制真实模型测试次数，后续按未覆盖要求和必要修复复核继续，产品单次调用预算不变。

追加语义复验已完成12次操作/28次请求，覆盖新ID、歧义、假设/群体、主观问句、冲突设定和异地称呼；本次42操作/85请求的原始失败与修复复核见报告。结构检查不等于语言质量通过，历史NPC core验收不替代本次要求。开局创建、完整知识披露、耳语/遮挡、无限历史、多人公平调度及数据库归档不在本次扩展范围。

不写测试文件。使用npm run check、已有服务、Pi模型边界及人工试玩验证，正常运行产物在被忽略的data目录，凭据不进入报告。完整完成条件仍是PRD AC-01～AC-15，不因本文按实现整理而缩小。
