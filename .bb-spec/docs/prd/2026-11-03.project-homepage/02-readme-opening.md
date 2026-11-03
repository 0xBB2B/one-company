---
name: 02-readme-opening
description: 重写 README 开头：一句话介绍、真实徽章、主页入口和"为什么用 OneCompany"
date: 2026-11-03
---

# README 开头

## 用户故事

### P0：作为第一次打开仓库的读者，我想要 README 开头讲清楚项目是什么、为什么用它，以便决定要不要继续看

**用例（主路径）**
- 场景：读者不认识 pi，也没听说过 OneCompany，在 GitHub 上打开仓库。
- 操作：从上往下读 README 的开头。
- 预期：读者知道 pi 是什么、OneCompany 是 pi 的扩展包、四条核心卖点和一个需求的流程，然后才看到「前置条件」。

**用例（边界）**
- 场景：不懂中文的读者打开 README。
- 操作：找英文入口。
- 预期：能看到一句英文，它指向主页，并写明产品界面和 README 目前是中文。

## 约束

- 改动范围是 `README.md` 第一个 `## 前置条件` 之前的内容；`## 前置条件` 及后面的内容一个字不改。
- 开头从上到下依次是：横幅图、一句话介绍、徽章、导航、分隔线、`## 为什么用 OneCompany`、`## 前置条件`。
- 横幅图用 `assets/onecompany-banner.webp`，宽度 100%，替代文字是 `OneCompany: One human. A governed autonomous company.`
- 去掉图下的 `<h1>OneCompany</h1>` 和 `One human. A governed autonomous company.` 这一行。
- 一句话介绍居中加粗，全文是：`你说需求、点头确认，后台的 AI 团队把它规划、实现、审查、验收完。`
- 徽章有四个：License: MIT（链到 `LICENSE`）、pi package（链到 `#前置条件`）、Node >=22.19（链到 `package.json`）、homepage（文字是 `one-company.0xbb.me`，链到主页 `https://one-company.0xbb.me/`）。Tests 徽章删除。
- 导航依次是：主页 · Homepage、为什么用它、前置条件、安装、上手、功能、设置、设计规范样例、原理、已知限制、常见问题、参与开发。其中"主页 · Homepage"链到 `https://one-company.0xbb.me/`，"为什么用它"链到 `#为什么用-onecompany`，"参与开发"链到 `CONTRIBUTING.md`，其余链到 README 内对应的标题，`[设计规范样例](#设计规范样例)` 这段写法保持不变。
- `## 为什么用 OneCompany` 的内容依次是：

  第一段（其中 pi 链到 `https://github.com/earendil-works/pi`）：

  > OneCompany 是 pi（一个在终端里运行的编码代理）的扩展包。它让模型按一家有规矩的公司那样干活：你只和主代理（和你对话的那个代理）说话，PM 拆任务，worker 写代码，reviewer 审查，QA 验收。

  四条列表，每条的标题加粗：

  - **只有你能批准**：批准和裁决只认你的原话和你在程序窗口里的选择。代理说"用户同意了"不算数，代理之间也不能互相批准。
  - **自称完成不算完成**：各角色的权限、版本和阶段门槛都由程序核对。代理说"通过了"不能代替实际检查。
  - **改动不出范围**：worker 改了本需求任务范围外的文件，结果被拒收。写入范围重叠的任务不会同时派出。
  - **每处改动查得回需求**：提交带需求编号，需求完成时正文和原型归档进分支。以后能从代码查到当初为什么这样做。

  一句引导：`一个需求这样走完，后面三处"你"只有你能做：`

  一个代码块，只有一行：`理清需求 → 你批准 → PM 规划 → worker 实现 → reviewer 审查 → QA 验收 → 你验收 → 你交付`

  一句英文（其中 homepage 链到主页）：`Looking for English? Start at the homepage. The product UI and this README are in Chinese today.`
- README 现有的二级标题顺序不变，新标题排在它们前面。

## 验收

- [ ] `README.md` 里 `## 前置条件` 及后面的内容和改动前完全相同。
- [ ] 开头的区块顺序和约束一致。
- [ ] 横幅图路径、宽度和替代文字和约束一致。
- [ ] README 里没有 `<h1`，开头没有单独一行的 `One human. A governed autonomous company.`
- [ ] 一句话介绍和约束一字不差。
- [ ] 四个徽章的文字和链接和约束一致，README 里没有 `badge/tests`。
- [ ] 导航 12 项的顺序和链接和约束一致，含 `[设计规范样例](#设计规范样例)`。
- [ ] `## 为什么用 OneCompany` 的段落、四条列表、流程和英文句子和约束一字不差，pi 和 homepage 的链接正确。
- [ ] 二级标题里 `为什么用 OneCompany` 排在 `前置条件` 前面，其余顺序不变。

## 验证路径

1. 跑 `pnpm test -- tests/user-documentation.test.ts` → 全部通过。
2. 用 `git diff main -- README.md` 看改动 → 只有 `## 前置条件` 之前的行有变化。
3. 在 GitHub 上看分支的 README → 第一屏能看到横幅图、一句话介绍、徽章和导航，点导航里的"为什么用它"能跳到对应标题。
