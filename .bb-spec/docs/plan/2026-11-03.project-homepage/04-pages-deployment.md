---
name: 04-pages-deployment
description: 新建 GitHub Actions 工作流，把 site 目录发布到 GitHub Pages
---
# 主页自动发布

## 目标
`main` 上 `site/` 有变化时，主页自动更新到 GitHub Pages。

## 业务规则（来源：PRD 04-pages-deployment）
- 触发条件只有两种：推送到 `main` 且改动涉及 `site/**` 或这个工作流文件；在 Actions 页面手动运行。
- 只发布 `site` 目录。不装依赖，不构建。
- 权限只有 `contents: read`、`pages: write`、`id-token: write`。
- 同一时间只有一个部署，排队的旧部署被取消。运行中的部署不取消，避免发布到一半被打断。
- Action 版本经官方渠道核实：`actions/checkout` v7.0.1、`actions/upload-pages-artifact` v5.0.0、`actions/deploy-pages` v5.0.1（2026-11-03 用 `gh api repos/<owner>/<repo>/releases/latest` 查到，都是最新稳定版）。
- 改 `site/` 不改变守护进程的代码指纹：指纹只算 `src/`、`resources/` 和 `package.json`。
- 打开 Pages、设置仓库主页字段、合并到 `main` 都要用户另外授权，不在本 plan 内执行。

## 涉及文件
- 新建：`.github/workflows/pages.yml`
- 新建：`tests/pages-deployment.test.ts`

## 成品定义

`.github/workflows/pages.yml` 的完整内容，原样落盘：

```yaml
name: Pages

on:
  push:
    branches: [main]
    paths:
      - "site/**"
      - ".github/workflows/pages.yml"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: actions/upload-pages-artifact@v5.0.0
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v5.0.1
```

## 函数清单
无业务代码。

## 协作关系
依赖 `site/index.html`。部署依赖仓库 Pages 来源设为 GitHub Actions，这一步在用户授权后操作。

## 验证方式
- 测试入口：`pnpm exec vitest run tests/pages-deployment.test.ts tests/code-fingerprint.test.ts`
- 测试输入：仓库里的 `.github/workflows/pages.yml`、`package.json`；临时包目录里改 `site/index.html`。
- 预期结果：
  - 工作流文本含 `branches: [main]`、`site/**`、`workflow_dispatch`、`path: site`，三个 Action 都写到完整版本号。
  - 没有 `npm`、`pnpm`、`pull_request`。
  - 顶层权限只有三项。
  - `package.json` 的 `files` 不含 `site`。
  - 只改 `site/index.html` 时 `codeFingerprint` 的结果不变（在 `tests/code-fingerprint.test.ts` 里按"只改 README.md，指纹不变"的写法加一条）。
- [ ] 两个测试文件全部通过。
- [ ] `pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过。
