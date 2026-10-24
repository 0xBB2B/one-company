---
name: rework-full-review
description: 返修后再派审查时，通用审查和任务审查名单里全部开着的专项审查都重新审一遍
date: 2026-10-24
---

# 返修后全部重审

几个词先说清：
- 通用审查：内置的 reviewer 定义，每个 worker 任务都派。
- 专项审查：按技术栈划分的审查定义（如 go-reviewer），只按自己预设的 skill 审。
- 审查名单：任务里写的、同栈自动挂上的和 PM 临时加的专项审查。
- 一轮审查：worker 交出一次改动后，这次改动收到的全部审查；返修完再派审查算下一轮。

## 用户故事
### P0：作为用户，我想要返修改过的代码被所有审查重新查一遍，以便返修新写的代码也按每种技术栈的规范查过
**用例（主路径）**
- 场景：任务 T3 用 go-worker，审查名单是 go-reviewer、vue-reviewer，都开着。第 1 轮 reviewer 打回（缺一个接口），go-reviewer、vue-reviewer 通过。
- 操作：PM 派 worker 返修，返修完再派审查。
- 预期：第 2 轮 reviewer、go-reviewer、vue-reviewer 三个同时启动；通用审查收到的说明写明 Go、Vue 的 skill 由对应专项审查核对；三个都通过 T3 才完成。

**用例（边界：专项审查被关掉）**
- 场景：同上，返修期间用户关掉了 vue-reviewer。
- 操作：返修完再派审查。
- 预期：第 2 轮只启动 reviewer 和 go-reviewer；vue-reviewer 负责、go-reviewer 没覆盖的 skill 加载给通用审查，说明里写明由它核对；面板上 vue-reviewer 那一行是「已关闭（或已不存在）本轮未审」。

**用例（边界：同一轮里重派）**
- 场景：第 2 轮 go-reviewer 没交出结论，其他两个通过。
- 操作：PM 再派审查。
- 预期：同一轮里只重派 go-reviewer。

## 约束
- C-1：返修完再派审查时（新一轮），派出通用审查和审查名单里全部开着、还存在的专项审查，和第 1 轮一样。
- C-2：同一轮里再派审查时，只重派没交出结论（还能重派）或被作废的代理，和现在一样。
- C-3：给通用审查分 skill 时，按这一轮实际派出的专项审查算覆盖；关掉或不存在的专项审查不算覆盖，它负责的 skill 加载给通用审查。
- C-4：状态面板上，返修后这一轮的每个专项审查都显示本轮的状态（在跑、通过、打回、没交出结论、被作废、已关闭本轮未审），没有「上一轮已通过」这种状态。
- C-5：PM 收到的审查派出说明和 PM 的职责规矩里，写明返修后全部审查重新审一遍。

## 验收
- [ ] AC-1 ← C-1：第 1 轮 reviewer 打回、go-reviewer 和 vue-reviewer 通过，返修后派审查 → 启动 reviewer、go-reviewer、vue-reviewer；第 1 轮 go-reviewer 打回、vue-reviewer 通过 → 同样三个都启动。
- [ ] AC-2 ← C-2：第 2 轮 go-reviewer 没交出结论，再派审查 → 只启动 go-reviewer，轮次仍是第 2 轮。
- [ ] AC-3 ← C-3：返修期间关掉 vue-reviewer，再派审查 → 不启动 vue-reviewer；通用审查加载了 vue-reviewer 负责、go-reviewer 没覆盖的 skill，说明写明由它核对；Go 的 skill 写明由 go-reviewer 核对。
- [ ] AC-4 ← C-4：返修后的一轮里，面板上每个专项审查一行，写的是本轮状态；面板文字里不出现「上一轮已通过」。
- [ ] AC-5 ← C-5：PM 的职责规矩和审查派出的工具说明里有「返修后全部审查重新审一遍」的意思，没有「只重审打回的」。

## 验证路径
1. 给一个 Go 加 Vue 的任务挂 go-reviewer、vue-reviewer，第 1 轮只让 reviewer 打回（AC-1）。
2. 返修后派审查，看同时启动了哪些运行、面板每行写什么（AC-1、AC-4）。
3. 让 go-reviewer 这一轮没交出结论，再派一次（AC-2）。
4. 另起一次，返修期间关掉 vue-reviewer 再派（AC-3）。
