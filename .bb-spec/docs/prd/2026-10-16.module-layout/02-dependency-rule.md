---
name: dependency-rule
description: 源文件必须在模块目录里、下层模块不能引用上层模块，两条都用架构测试守住
date: 2026-10-16
---

# 单向依赖规则与架构测试

模块：`src/core/<名>/`、`src/modules/<名>/` 下的一个目录，或组装层 `src/app/extension/`、`src/app/daemon/`。架构测试：一条普通的单元测试，读出 `src/` 下所有源文件的 import，检查放置位置和引用方向。

## 用户故事
### P0：作为维护这个仓库的开发者，我想要模块之间只能单向引用、违反时测试失败，以便改下层模块时能确定只影响它上面的模块，目录也不会慢慢乱回去
**用例（主路径）**
- 场景：开发者在需求模块里写新代码，顺手引用了 PM 模块的函数。
- 操作：跑单元测试。
- 预期：架构测试失败，报错写明"src/modules/requirement/<文件>:<行> 引用了上层模块 pm（src/modules/pm/<文件>）"。

**用例（边界：新文件放错位置）**
- 场景：开发者把新文件直接放在 `src/modules/` 下，没有放进某个模块目录。
- 操作：跑单元测试。
- 预期：架构测试失败，报错写明这个文件不在任何模块目录里。

## 约束
- C-1：模块从下层到上层的顺序固定为：core/policy、core/exec、core/storage、core/host、agents、requirement、prototype、verification、explore、settings、pm、delivery、panel、interaction、project-index、shell、app（app 包含 `src/app/extension` 和 `src/app/daemon`）。一个文件可以引用同一模块里的文件和排在它下面的模块；引用排在它上面的模块时，架构测试失败。只引用类型的 import 同样检查。
- C-2：引用方向错误时，报错逐条写明"<引用方文件>:<行> 引用了上层模块 <模块名>（<被引用的文件>）"，一次列出全部违规。
- C-3：`src/` 下有 `.ts`、`.mjs` 源文件不在 C-1 的任何模块目录里时，架构测试失败，报错写明"<文件> 不在任何模块目录里"。
- C-4：搬家后原来下层引用上层的 4 处改为单向：守护进程客户端用到的"探测已有守护进程实例""通信文件路径长度上限"两个函数，以及通信格式用到的三组数据格式定义（需求的 hash/id/positive、派原型设计师的输入、知识查询的传输格式），挪到 core 里不再引用上层；函数体和数据格式定义的内容不改，原来使用它们的地方改为从新位置引用。
- C-5：当前代码上架构测试通过，不需要任何例外。

## 验收
- [ ] AC-1 ← C-1、C-2：在 `src/modules/requirement/` 的一个文件里加一行引用 `src/modules/pm/` 某文件的 import（普通 import 和 `import type` 各试一次），架构测试失败，报错是"<该文件>:<行> 引用了上层模块 pm（<被引用的文件>）"；同时加两处违规时，报错里两处都有。
- [ ] AC-2 ← C-1：`src/modules/pm/` 里的文件引用 `src/modules/requirement/`、同模块文件、`src/core/` 下的文件，架构测试不报错。
- [ ] AC-3 ← C-3：在 `src/modules/` 下直接放一个 `.ts` 文件，架构测试失败，报错写明这个文件不在任何模块目录里。
- [ ] AC-4 ← C-4：`src/core/` 下没有任何文件引用 `src/modules/` 或 `src/app/`；守护进程客户端照常连接、启动守护进程（集成测试通过）。
- [ ] AC-5 ← C-5：在当前代码上跑架构测试，通过，测试里没有例外清单。

## 验证路径
1. 在当前代码上跑架构测试，确认通过（AC-5）。
2. 临时加一行下层引用上层的 import，跑测试看报错；再加一行 `import type` 的版本（AC-1）。
3. 临时在 `src/modules/` 下放一个文件，跑测试看报错（AC-3）。
4. 检查 `src/core/` 下所有 import 的目标，跑集成测试（AC-2、AC-4）。
