---
name: 02-readme-opening
description: 重写 README 第一个二级标题之前的内容，新增"为什么用 OneCompany"
---
# README 开头

## 目标
读者在 README 第一屏知道项目是什么，往下看到核心卖点和流程，然后才是前置条件。

## 业务规则（来源：PRD 02-readme-opening）
- 只改 `README.md` 里 `## 前置条件` 之前的内容；`## 前置条件` 这一行及后面一个字不改。
- 去掉图下的 `<h1>` 和英文标语行，删除 Tests 徽章（它是静态图片，不反映测试结果）。
- `[设计规范样例](#设计规范样例)` 这段写法保持不变，`tests/user-documentation.test.ts` 依赖它。
- 现有二级标题顺序不变，`为什么用 OneCompany` 排在它们前面。
- pi 的链接是 `https://github.com/earendil-works/pi`，主页是 `https://one-company.0xbb.me/`。

## 涉及文件
- 修改：`README.md`
- 修改：`tests/user-documentation.test.ts`

## 成品定义

把 `README.md` 中 `## 前置条件` 之前的全部内容替换成下面这段（最后保留一个空行，再接 `## 前置条件`）：

```markdown
<p align="center">
  <img src="assets/onecompany-banner.webp" alt="OneCompany: One human. A governed autonomous company." width="100%" />
</p>

<div align="center">

**你说需求、点头确认，后台的 AI 团队把它规划、实现、审查、验收完。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-8A2BE2.svg)](#前置条件)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen.svg)](package.json)
[![Homepage](https://img.shields.io/badge/homepage-one--company.0xbb.me-0A58CA.svg)](https://one-company.0xbb.me/)

[主页 · Homepage](https://one-company.0xbb.me/) · [为什么用它](#为什么用-onecompany) · [前置条件](#前置条件) · [安装](#安装) · [上手](#上手) · [功能](#功能) · [设置](#设置) · [设计规范样例](#设计规范样例) · [原理](#原理) · [已知限制](#已知限制) · [常见问题](#常见问题) · [参与开发](CONTRIBUTING.md)

</div>

---

## 为什么用 OneCompany

OneCompany 是 [pi](https://github.com/earendil-works/pi)（一个在终端里运行的编码代理）的扩展包。它让模型按一家有规矩的公司那样干活：你只和主代理（和你对话的那个代理）说话，PM 拆任务，worker 写代码，reviewer 审查，QA 验收。

- **只有你能批准**：批准和裁决只认你的原话和你在程序窗口里的选择。代理说"用户同意了"不算数，代理之间也不能互相批准。
- **自称完成不算完成**：各角色的权限、版本和阶段门槛都由程序核对。代理说"通过了"不能代替实际检查。
- **改动不出范围**：worker 改了本需求任务范围外的文件，结果被拒收。写入范围重叠的任务不会同时派出。
- **每处改动查得回需求**：提交带需求编号，需求完成时正文和原型归档进分支。以后能从代码查到当初为什么这样做。

一个需求这样走完，后面三处"你"只有你能做：

```text
理清需求 → 你批准 → PM 规划 → worker 实现 → reviewer 审查 → QA 验收 → 你验收 → 你交付
```

Looking for English? Start at the [homepage](https://one-company.0xbb.me/). The product UI and this README are in Chinese today.
```

## 函数清单
无业务代码。

## 协作关系
`tests/user-documentation.test.ts` 的 `REQUIRED_SECTION_ORDER` 只比较已有标题的相对顺序，不用改。新增的测试放在同一文件的新 `describe` 里。

## 验证方式
- 测试入口：`pnpm exec vitest run tests/user-documentation.test.ts`
- 测试输入：仓库里的 `README.md`；`git show main:README.md` 取改动前的内容。
- 预期结果：
  - 不含 `badge/tests`，不含 `<h1`。
  - 含一句话介绍、四个徽章链接、12 项导航、四条卖点、流程行和英文句子的原文。
  - `## 为什么用 OneCompany` 排在 `## 前置条件` 前面。
- [ ] 文件内全部测试通过。
- [ ] `git diff 783c1e5 -- README.md` 只有 `## 前置条件` 之前的行变化（一次性确认，不写成常驻测试：以后 README 后半部分会正常改动）。
