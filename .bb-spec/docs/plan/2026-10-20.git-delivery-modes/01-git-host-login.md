---
name: 01-git-host-login
description: 新增底层函数：认出 origin 所在主机，只读本机 gh/glab 登录记录判断平台，得出 Git 交付的内置默认档位
---
# origin 主机与本机登录记录

## 目标
任何模块（设置、守护进程、交付）都能不联网地回答三个问题：origin 在哪台主机；这台主机在本机 gh 还是 glab 里登录过；没设置时 Git 交付默认用"远程"还是"仅本地"。

## 业务规则（来源：PRD 03-delivery-settings、04-remote-delivery）
- Git 交付两档：`remote`（远程）和 `local`（仅本地）。内置默认值：有 origin，并且 origin 所在主机在本机 gh 或 glab 的登录记录里 → `remote`；否则 `local`。只读本机登录记录，不联网，私有部署也按登录记录认（03 C-3）。
- 认平台：主机在 gh 里登录过 → GitHub（gh）；否则在 glab 里登录过 → GitLab（glab）；都没有 → 认不出（04 C-1）。
- gh 的登录记录：`gh auth token --hostname <主机>` 退出码 0 即登录过（实测不联网：已登录主机返回 0、未登录返回 1）。本机没装 gh 时当作没登录。
- glab 的登录记录（glab 文档"Configure the CLI"）：配置文件按顺序取第一个存在的：`$GLAB_CONFIG_DIR/config.yml` → `~/.config/glab-cli/config.yml` → `$XDG_CONFIG_HOME/glab-cli/config.yml`（未设 XDG_CONFIG_HOME 时 macOS 为 `~/Library/Application Support/glab-cli/config.yml`、Linux 为 `~/.config/glab-cli/config.yml`）→ `$XDG_CONFIG_DIRS/glab-cli/config.yml`（默认 `/etc/xdg/glab-cli/config.yml`）。文件 `hosts:` 段下一级键名里有这台主机 → 登录过。另外，环境变量 `GITLAB_TOKEN`、`GITLAB_ACCESS_TOKEN`、`OAUTH_TOKEN` 任一有值，并且主机等于 `GITLAB_HOST`（依次回退 `GITLAB_URI`、`GL_HOST`，都没有时是 `gitlab.com`；值可能是 URL，取其主机名）时也算登录过——文档说环境变量"不按主机区分"，所以只认它指向的那台。
- 不能用 `glab auth status`（实测会请求 `https://gitlab.com/api/v4/user`）或 `glab config get token --host`（对任何主机都返回环境变量里的 token）。
- 不引入 YAML 库：逐行找顶格的 `hosts:`，再取下一级缩进的 `<主机>:` 键名。

## 涉及文件
- src/core/exec/git-host.ts（新建）
- tests/git-host.test.ts（新建）

## 函数清单
### src/core/exec/git-host.ts
| 函数名 | 职责 |
|---|---|
| `DeliveryMode` | 类型：`"remote" \| "local"`，设置、目标分支、交付共用 |
| `GitProvider` | 类型：`"gh" \| "glab"` |
| `originHost` | 读 `git remote get-url origin`，从 `git@host:path`、`ssh://user@host:port/path`、`https://host/path` 等写法取出主机名（小写，去端口）；没有 origin 或是本地路径时返回 null |
| `ghLoggedIn` | 用 `gh auth token --hostname <主机>` 的退出码判断；输出丢弃不保存，gh 不存在时返回 false |
| `glabLoggedIn` | 按上面的顺序找 glab 配置文件并解析 `hosts:` 键名，再看环境变量规则 |
| `providerForHost` | 先 gh 后 glab，返回登录过的平台或 null |
| `detectDeliveryMode` | 组合以上三步，返回 `{ mode, host, provider }`：mode 按内置默认规则得出，host 为 null 表示没有 origin |

## 协作关系
- 调 git 用 `src/core/exec/target-branch.ts` 的 `gitIn`；调 gh 用 node `execFile`，带 `GH_PROMPT_DISABLED=1`，超时 10 秒。
- 使用方：settings 模块算内置默认档位（plan 02）；交付认平台（plan 06）。

## 验证方式
- 测试入口：`src/core/exec/git-host.ts` 的导出函数。
- 测试输入：在 `temporaryRoot()` 下建仓库并设置各种 origin 写法；把假 `gh` 脚本放到 PATH 最前（按环境变量 `FAKE_GH_HOSTS` 决定哪些主机退出码为 0，并把收到的参数追加写入日志文件）；用临时目录作 `GLAB_CONFIG_DIR` 写 config.yml；按需设置或清空 `GITLAB_TOKEN`、`GITLAB_HOST`、`XDG_CONFIG_HOME`、`HOME`。
- 预期结果：
- [ ] `git@github.com:acme/shop.git`、`ssh://git@code.example.com:2222/acme/shop.git`、`https://GitLab.Example.com/acme/shop.git` 分别得到 `github.com`、`code.example.com`、`gitlab.example.com`；没有 origin、origin 是本地路径时得到 null。
- [ ] `FAKE_GH_HOSTS=github.com` 时 github.com 判为 gh 登录过、其他主机不是；假 gh 日志里的参数是 `auth token --hostname <主机>`；PATH 里没有 gh 时返回 false 不报错。
- [ ] glab 配置文件 `hosts:` 下有 `code.example.com:` 时该主机判为 glab 登录过；文件不存在、或 `hosts:` 下没有该主机时不是；`GLAB_CONFIG_DIR` 优先于 `~/.config/glab-cli/config.yml`。
- [ ] 只设 `GITLAB_TOKEN` 时 gitlab.com 判为登录过、code.example.com 不是；再设 `GITLAB_HOST=https://code.example.com` 后反过来。
- [ ] `detectDeliveryMode`：gh 登录过 origin 主机 → `{mode:"remote", provider:"gh"}`；只有 glab 登录过 → `{mode:"remote", provider:"glab"}`；都没登录 → `{mode:"local", provider:null}`；没有 origin → `{mode:"local", host:null}`。
- [ ] 测试过程中不发出网络请求（假 gh 不联网；不调用 glab 可执行文件）。
