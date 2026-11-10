# lean-tool-results 实施计划

## 阶段 1：共用包装
- [01-lean-result-helper](01-lean-result-helper.md) — 把完整结果和发给模型的视图包成 pi 工具结果，视图函数同时拿到调用参数

## 阶段 2：工具结果精简
- [02-knowledge-query](02-knowledge-query.md) — 知识查询主代理和子代理一起精简，分页按发给模型的内容算 [依赖: 01-lean-result-helper]
- [03-main-tool-results](03-main-tool-results.md) — 主代理 agent_manage、prototype、workflow_manage、git_deliver、project_manage 精简 [依赖: 01-lean-result-helper]
- [04-subagent-tool-results](04-subagent-tool-results.md) — 子代理验证、写入、计划、流程、派工、提交、同步、联网搜索工具精简 [依赖: 01-lean-result-helper]
- [07-subagent-requirement-read](07-subagent-requirement-read.md) — 子代理读需求正文精简，分页按发给模型的内容算 [依赖: 01-lean-result-helper, 04-subagent-tool-results]

## 阶段 3：检索结果
- [05-explore-main](05-explore-main.md) — 主窗口检索结果只给结论，sources 按编号取来源 [依赖: 01-lean-result-helper, 03-main-tool-results]
- [06-explore-pm](06-explore-pm.md) — PM 收到的检索结果只给结论，完整报告存本机数据库，sources 取来源 [依赖: 05-explore-main, 04-subagent-tool-results]

## 阶段 4：主窗口卡片
- [08-card-renderer](08-card-renderer.md) — 共用卡片渲染，需求和交互工具卡片 [依赖: 01-lean-result-helper, 03-main-tool-results, 05-explore-main]
- [09-tool-cards](09-tool-cards.md) — 其余工具和检索结果消息的卡片 [依赖: 08-card-renderer, 02-knowledge-query, 03-main-tool-results, 05-explore-main]

## 后一批（另一个需求 requirement-follows-conversation 合并、本分支同步后再出计划）
- 主代理 requirement_manage、user_interact 的结果精简，以及接手复核（pm-intake）卡片
