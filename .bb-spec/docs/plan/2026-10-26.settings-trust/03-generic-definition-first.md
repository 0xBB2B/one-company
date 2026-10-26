---
name: generic-definition-first
description: 设置页角色分区第一行是同名通用定义，下面画一条灰色分隔线，其他定义顺序不变
---
# 通用定义置顶

## 目标
`/one:setting` 的 worker、reviewer、qa、explore、prototype 分区里，和分区同名的通用定义永远在第一行，有其他定义时下面画一条灰色分隔线。

## 业务规则（来源：PRD generic-definition-first）
- 和分区同名的定义排第一行，不管来源是内置、用户还是项目层（C-1）。例：用户层覆盖了 worker，第一行仍是 worker，来源显示"用户"。
- 分区里还有别的定义时，第一行下面画分隔线：3 列空白（光标列）后接灰色（theme 的 "dim"）"─"，画到右栏最右边；其他定义在线下，顺序不变：非内置（用户、项目）在前、内置在后，同类按名字排（C-2）。
- 分区里只有通用定义时不画分隔线（C-3）。
- 分隔线只是显示，不是一行：↑↓、回车详情、空格开关、C 复制、页面状态里记住的选中名字都只认定义行。通用定义展开详情时，详情显示在它和分隔线之间（C-4）。
- 目录里分区后面的数字仍是定义个数，不算分隔线（C-5）。
- 36 到 80 列下分隔线不超过终端宽度；窄于 60 列只显示右栏时，分隔线画到终端最右边（C-6）。
- 宽终端下左右两栏的总行数按 `3 + rowCount(section)` 预留高度；有分隔线的分区内容多一行，要保证页面高度按实际行数算，不截掉最后一行。

## 涉及文件
- 修改 `src/modules/settings/settings-page-ui.ts`

## 函数清单
### src/modules/settings/settings-page-ui.ts
| 函数名 | 职责 |
|---|---|
| `SettingsPageView.entries` | 排序改为：和分区同名的排第一，其余保持现有排序 |
| `SettingsPageView.definitionPane` | 第一行是同名通用定义且后面还有定义时，在它（含展开的详情）之后插入分隔线 |
| `SettingsPageView.render` | 宽终端按分区预留高度时，把分隔线那一行算进去 |

## 协作关系
`render` → `paneLines` → `definitionPane` → `entries`；`rowNames`、`state`、按键处理都用 `entries()` 的下标，分隔线不进 `entries()`，所以光标逻辑不变。

## 验证方式
- 测试入口：`SettingsPageView` 的 `render(width)` / `handleInput`，用 tests/settings-page-ui.test.ts 的 `page(...)` 构造。
- 测试输入：worker 分区有内置 worker、6 个内置专项 worker 和一个用户层 my-worker；另一组在用户层放 worker.md 覆盖内置 worker；qa 分区只有内置 qa；终端宽 36、44、60、80。
- 预期结果：
  - worker 分区表头下第一行是 worker，第二行是 3 列空白加"─"到右栏最右边，线下依次 my-worker、go-worker、java-worker、node-worker、python-worker、react-worker、vue-worker。
  - 用户层覆盖时第一行仍是 worker，来源"用户"。
  - qa 分区只有一行，没有"─"行。
  - 光标在 worker 按 ↓ 到 my-worker，再按 ↑ 回 worker；worker 上按回车，详情行出现在 worker 和分隔线之间。
  - 目录里 worker 后面的数字等于定义个数。
  - 各宽度下每行显示宽度不超过终端宽度。
- [ ] 通用定义第一行（含被用户层覆盖）
- [ ] 分隔线位置、样式、线下顺序
- [ ] 只有通用定义时没有分隔线
- [ ] 光标跳过分隔线；详情在分隔线上方
- [ ] 目录数字不变；各宽度不超宽
