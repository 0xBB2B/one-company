# 当前规则格式与校验边界

`schema.json` 是 `docs/spec/schema.json` 的分发源。它定义版本1的 JSON 字段白名单；本模块不自动覆盖业务项目的现有目录或发布规则。共享文件中不包含PM、任务、授权、会话或本机绝对路径。

`runtime/spec-format.ts` 的内部函数 `checkSpecSet(sources)` 校验调用方已授权提供的整个当前规则集合：

- 路径必须位于 `docs/spec`，文件扩展名为 `.rules.json`。
- 严格解析JSON，按解码后的键拒绝重复项；拒绝畸形文本、孤立Unicode代理码点和非有限数字。
- 规则字段为id/title/condition/trigger/expected/reason/dependsOn/exceptions/acceptance；功能字段为id/title/aliases，场景字段为id/given/when/then。未知字段及外部schema入口拒绝，不联网解析 `$schema`。
- `dependsOn` 和 `exceptions` 都是稳定规则ID引用；例外的条件和行为由引用规则自身定义，不在引用字段中携带正文。引用必须属于当前集合，禁止重复、悬空和循环。单条场景ID在规则内唯一，规则ID在集合内唯一。
- 单条自然语言总量最多1500个Unicode码点，计入功能标题/别名、规则标题/条件/触发/结果/原因及所有场景文字；最多6个场景。真实文本超过上限即要求拆分，不截断或自动删场景。
- 对象键用固定排序，数组保序；不修剪文本、不做Unicode归一化。fileHash覆盖原UTF-8文本字节，contractHash覆盖规则、功能上下文、schema指纹及引用规则的当前指纹；集合指纹覆盖完整ID/hash集合。排版变化可只改变fileHash，引用行为改变会影响依赖规则。

结构校验成功仅表示格式、大小和引用检查通过。返回的 `semanticReview.required` 始终为true：单一职责、跨功能影响、合法例外和语义冲突仍需审查。程序只标出同功能、同条件/触发但结果不同的明显冲突候选，不把“没有候选”当作无冲突证明。

函数只处理传入的当前资料，不读取Git历史、归档prod或旧hash正文，不写数据库/业务文件，不注册新业务工具；错误直接拒绝，不使用上次有效值补齐。未实现的发布、授权、索引和生命周期服务不能借此返回值宣称验收完成。

普通JSON编辑器可以查看schema与规则；1500码点的跨字段总量由产品校验函数执行，通用JSON Schema校验器可能忽略 `x-maxRuleCodepoints`，不能单独替代完整检查。
