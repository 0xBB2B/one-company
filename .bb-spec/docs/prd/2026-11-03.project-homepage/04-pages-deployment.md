---
name: 04-pages-deployment
description: 用 GitHub Actions 把 site 目录发布到 one-company.0xbb.me，并随 main 分支更新
date: 2026-11-03
---

# 主页自动发布

## 用户故事

### P0：作为维护者，我想要改完 `site/` 合进 `main` 后主页自动更新，以便不用手动部署

**用例（主路径）**
- 场景：维护者改了 `site/index.html`，合并到 `main`。
- 操作：等部署任务跑完。
- 预期：打开 `https://one-company.0xbb.me/` 看到新内容。

**用例（边界）**
- 场景：维护者只改了 `src/` 下的代码，合并到 `main`。
- 操作：看 Actions 页面。
- 预期：部署任务没有运行。

**用例（异常）**
- 场景：部署任务失败。
- 操作：看 Actions 页面和主页。
- 预期：Actions 页面显示失败，线上主页保持上一版。

### P1：作为维护者，我想要能手动重新部署，以便部署失败后不用改代码就能重试

**用例（主路径）**
- 场景：上次部署因为 GitHub 的临时故障失败了。
- 操作：在 Actions 页面手动运行这个工作流。
- 预期：部署重新跑一次。

## 约束

- 工作流文件是 `.github/workflows/pages.yml`。
- 代码推送到 `main` 分支、且改动涉及 `site/` 下的文件或这个工作流文件本身时，工作流自动运行。
- 工作流支持在 Actions 页面手动运行。
- 其他分支的推送和其他文件的改动不触发工作流。
- 发布的内容只有 `site/` 目录，线上访问不到 `src/`、`README.md`、`.bb-spec/` 等仓库其他文件。
- 工作流只申请部署需要的最小权限：读仓库内容、写 Pages、写部署身份令牌。
- 工作流用到的第三方 Action 都锁定到经官方渠道核实的版本。
- 同一时间只有一个部署在跑；新部署开始时，排队中的旧部署被取消。
- 工作流不需要安装依赖，也不运行构建。
- 主页地址是 `https://one-company.0xbb.me/`。仓库 Pages 设置的自定义域名填 `one-company.0xbb.me`，并开启强制 HTTPS。
- 用户在 `0xbb.me` 的 DNS 服务商处加一条 CNAME 记录：名称 `one-company`，指向 `0xbb2b.github.io`。必须先在 GitHub 填好域名，再加这条记录；不用通配符记录。原因：GitHub 官方文档要求这个顺序，否则别人可能抢先在这个子域名上挂站点。
- `site/` 里不放 `CNAME` 文件：用 Actions 发布时 GitHub 会忽略它。
- 仓库设置里的 Pages 来源是 GitHub Actions，仓库主页字段是 `https://one-company.0xbb.me/`。Pages 来源、自定义域名、强制 HTTPS 和主页字段这些设置，和合并到 `main` 一样，要用户另外授权后才操作。
- `package.json` 的 `files` 不加 `site`。
- 改 `site/` 不改变守护进程的代码指纹（根据安装目录里 `src/`、`resources/` 和 `package.json` 算出的摘要），所以不触发守护进程换新。

## 验收

- [ ] `.github/workflows/pages.yml` 存在，是合法的 GitHub Actions 工作流。
- [ ] 触发条件只有：推送到 `main` 且改动涉及 `site/**` 或这个工作流文件，以及手动运行。
- [ ] 发布目录是 `site`。
- [ ] 权限只有读内容、写 Pages、写身份令牌。
- [ ] 每个 Action 的版本都核实过，并锁定。
- [ ] 同一时间只有一个部署运行，旧的排队部署被取消。
- [ ] 工作流里没有安装依赖和构建步骤。
- [ ] `package.json` 的 `files` 里没有 `site`。
- [ ] 改 `site/` 下的文件后，代码指纹不变。
- [ ] `site/` 里没有 `CNAME` 文件。
- [ ] 用户授权后：Pages 来源设为 GitHub Actions，自定义域名是 `one-company.0xbb.me`，部署成功；DNS 生效后 `https://one-company.0xbb.me/` 能打开、开启了强制 HTTPS、访问不到仓库其他文件；仓库主页字段已设置。

## 验证路径

1. 读 `.github/workflows/pages.yml` → 触发条件、权限、发布目录和并发设置符合约束。
2. 跑 `pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` → 全部通过。
3. 用户授权后，用 `gh api` 把 Pages 来源设为 GitHub Actions、自定义域名设为 `one-company.0xbb.me`，合并到 `main` → Actions 页面里部署任务成功。
4. 用户加好 CNAME 记录后，`dig +short one-company.0xbb.me` → 返回 `0xbb2b.github.io.`；证书签好后开启强制 HTTPS（GitHub 文档说最多要等 24 小时）。
5. 打开 `https://one-company.0xbb.me/` → 显示主页；打开 `https://one-company.0xbb.me/README.md` → 404。
6. 只改 `src/` 下的文件并推送到 `main` → 部署任务没有运行。
