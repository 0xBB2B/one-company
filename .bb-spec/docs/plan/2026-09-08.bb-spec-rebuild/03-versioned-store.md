---
name: versioned-store
description: 本机数据区的原子文档写入、目录锁、状态版本冲突检测与追加型记录文件，供所有流程数据模块共用
---
# 带版本的本机存储

## 目标
窗口与守护进程可以并发读写同一份本机流程数据而不互相覆盖：整份文档原子落盘，更新必须基于已读版本，追加型记录逐行可校验。

## 业务规则（来源：spec）
- controlled-updates：查询返回状态版本，更新基于已读版本；两个窗口基于同一版本更新时后到的过期更新被拒绝并提示重新读取，先前内容保留；一次请求的字段全部通过才生效，不允许部分写入；保存未确认时返回失败或结果不明，不伪报成功。
- decision-append：并发追加不覆盖彼此，同一次成功追加只产生一条新记录；已有记录损坏时拒绝追加，不自动修补。
- local-ownership：流程数据只在本机保存，工作目录或分支删除不影响。

## 涉及文件
- 新建：runtime/store.ts
- 新建：tests/versioned-store.test.ts

## 函数清单

### runtime/store.ts
| 函数名 | 职责 |
|---|---|
| `readDocument` | 读取 JSON 文档并返回内容与 version；文件不存在返回空标记；内容不是合法 JSON 或缺少 version 抛出"损坏"错误 |
| `writeDocument` | 在目录锁内比对期望 version 后写入（临时文件 + fsync + rename），version 递增；不匹配抛出 `StaleVersionError` |
| `createDocument` | 仅当文件不存在时写入初始内容，version 为 1；已存在抛错 |
| `withDirLock` | 以 mkdir 锁目录串行化对同一目录的写操作，超时抛 `LockTimeoutError`，异常时释放锁 |
| `appendLine` | 在锁内把单行 canonical JSON 追加到记录文件，先校验既有内容每行 canonical 且以换行结尾，写后重读确认字节前缀不变 |
| `readLines` | 读取记录文件全部行并逐行解析，任一行非 canonical 抛出含行号的"损坏"错误 |
| `fileFingerprint` | 计算文件内容 sha256，供证据核对 |

## 协作关系
- 所有路径由 `runtime/identity.ts` 提供；本模块不感知业务含义。
- `writeDocument` 被 workflow-state、run-store、windows、ranges 使用；`appendLine` 被 decisions 与 relay 使用。
- 错误类 `StaleVersionError`、`LockTimeoutError` 被工具层翻译为用户可读回执。
- 依赖：Node 内置 fs（含 open/fsync/rename）、path、crypto。

## 验证方式
- 测试入口：`runtime/store.ts` 导出函数
- 测试输入：临时目录中的文档与记录文件；两个并发写入方（同进程并发 Promise 或两个子进程）
- 预期结果：
  - 首次 `createDocument` 后 `readDocument` 返回 version 1；重复 `createDocument` 抛错且内容不变
  - 两个写入方读到同一 version 后先后 `writeDocument`，第一个成功且 version 变为 2，第二个抛 `StaleVersionError`，文件内容为第一个写入方的内容
  - 写入过程中被中断（模拟 rename 前失败）后文件仍是旧内容，目录内无残留临时文件
  - 十个并发 `appendLine` 全部成功，文件恰有十行且每行 canonical，无交错
  - 记录文件中插入一行非 canonical 内容后，`appendLine` 与 `readLines` 均抛出含行号的损坏错误，文件未被修改
  - 锁被占用超过超时时间时 `withDirLock` 抛 `LockTimeoutError`；持锁函数抛异常后锁目录被移除
  - `fileFingerprint` 对相同内容返回相同值，改一个字节即不同
- [ ] 版本冲突保护
- [ ] 原子写与中断保护
- [ ] 并发追加与损坏拒绝
- [ ] 锁超时与异常释放
