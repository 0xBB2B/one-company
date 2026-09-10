---
name: versioned-store
description: SQLite 短事务、UUIDv7 主键、版本比较、顺序追加与崩溃恢复
---
# 带版本的本机存储

## 目标
pi-company 自有业务与审计记录经 SQLite 读写；普通运行日志使用按启动 UUIDv7 命名的 .log 文件。每仓一个 `repos/<repoId>/data.sqlite`，同仓 worktree 共用；全局设置与主会话 Shell 登记存 `global.sqlite`。

## 数据结构
`records` 保存可变记录：UUIDv7 主键 `id`、命名空间 `namespace`、业务键 `record_key`、递增 `version` 与 JSON 载荷 `data`。命名空间和业务键联合唯一。
`events` 保存追加条目：UUIDv7 主键 `id`、`stream`、事务内分配的 `sequence` 与 JSON 载荷 `data`。流和序号联合唯一。
数据库以 CHECK 约束拒绝非 UUIDv7 主键；业务标识和 SDK 内部条目引用不承担主键职责。UUIDv7 的时间部分不用于超时、精确排序或安全令牌。

## 事务与安全
开启 WAL、外键、同步落盘和 5 秒有界忙等待，使用 `user_version` 记录数据库版本。写事务为同步 `BEGIN IMMEDIATE`；禁止嵌套或异步回调，不在事务内等待 Git、网络、模型或用户。
更新与删除携带已读版本，SQL 条件不匹配时抛出 `StaleVersionError`。阶段推进与证据绑定、编号分配与事件追加、首答确认、送达回执合并、占用检查与登记必须在各自的同一事务完成。事务失败整体回滚。
数据库目录权限 0700，数据库及 WAL/SHM 权限 0600。数据库路径为普通文件，拒绝符号链接、坏数据库和不支持的版本；不得通过另一文件格式继续写入。

## 实现
`runtime/database.ts` 提供 UUIDv7、数据库路径、事务、版本记录与事件读写；Node 使用原生 node:sqlite，Bun 使用 bun:sqlite。`runtime/store.ts` 仅保留 Git 定义文件的原子替换及文件指纹，不承担应用数据持久化。

## 验证
- 首次读取无创建副作用；重复业务键与无效主键被拒绝。
- 过期版本拒绝且旧记录完整；同事务部分失败不产生记录或事件。
- Node 与 Bun 多进程并发追加，序号连续且 UUIDv7 不重复。
- 强杀未提交事务后重新打开，已提交内容完整、未提交内容消失、后续可继续追加。
- 符号链接和坏数据库失败关闭；数据库及 WAL/SHM 权限正确。
- Git 文件原子替换失败无临时文件残留，指纹随内容变化。
