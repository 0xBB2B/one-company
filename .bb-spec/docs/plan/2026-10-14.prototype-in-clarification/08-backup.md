---
name: backup
description: 需求备份带上各批准版本引用的原型文件，恢复时一并核对并放回原位，恢复后子代理照常读到
---
# 备份与恢复带上原型

## 目标
备份包含每个需求所有批准版本引用的原型文件。恢复后，这些文件回到恢复目录里的原位置，内容和指纹不变。

## 业务规则（来源：PRD backup-archive）
- 备份范围：所有版本快照引用到的原型文件，即每个需求、每个批准版本里的每份原型。草稿里还没批准的原型不保证包含。
- 文件在备份里的相对路径是 `prototypes/<requirementId>/<名称>.v<版本>.html`，和数据目录里的位置一样。备份清单照常记下每个文件的路径、大小和指纹。
- 打包时，文件的指纹必须和快照里记的一致；不一致就拒绝备份，原因写明哪份原型的文件被改过。
- 恢复时：
  - 备份清单里只认两类路径：现有的需求仓库路径，和上面这一类原型路径。出现别的路径就拒绝。
  - 每个原型文件的指纹要和清单一致，复制到恢复目录的同一相对位置。
  - 恢复后的核对把原型文件也算进去。
- 路径里不存数据目录的绝对位置，所以恢复到别的数据目录后，原型文件照样能按名称和版本找到。

## 涉及文件
- runtime/requirement-backup.ts（修改：收集原型文件，`requirementFiles` 之外再加一类）
- runtime/requirement-recovery.ts（修改：清单路径正则、完整性检查、`assertRestoredPayload`）
- tests/requirement-backup.test.ts（修改：加原型的备份与恢复用例）

## 函数清单
### runtime/requirement-backup.ts
| 函数名 | 职责 |
|---|---|
| `prototypeFiles`（新增） | 用 `allRevisionPrototypes` 列出要备份的原型文件，逐个核对指纹 |
| `createRequirementBackup`（修改） | 把这些文件和需求仓库文件一起写进备份 |
### runtime/requirement-recovery.ts
| 函数名 | 职责 |
|---|---|
| `validateManifest`（修改） | 路径正则放行 `prototypes/<UUIDv7>/<名称>.v<数字>.html` |
| `restoreRequirementBackup` / `assertRestoredPayload`（修改） | 原型文件随其他文件一起复制和核对 |

## 协作关系
- 依赖 06 的 `allRevisionPrototypes` 和 02 的 `prototypeFilePath`。
- 名称规则在 02 已经保证名称里没有 `/` 和控制字符，正则只需匹配"不含斜杠的一段"。

## 验证方式
- 测试入口：`createRequirementBackup`、`restoreRequirementBackup`（通过 project-maintenance 的备份、恢复入口），用临时数据目录（单层 `/tmp/pi-t-XXXXXX`）。
- 测试输入：一个需求。第 1 版快照里有"设置页" v2，第 2 版快照里有"设置页" v3；看板草稿里另有刚通过的"命令行输出" v1。
- 预期结果：
  - [ ] 备份清单里有"设置页" v2 和 v3 两个文件，路径、大小、指纹都对。
  - [ ] 打包前改动 v2 文件一个字节，备份被拒，原因写明哪份原型。
  - [ ] 恢复到另一个数据目录后，两个文件都在原相对位置、逐字节一致；用恢复后的目录按名称和版本推出路径，能读到它们。
  - [ ] 手工往清单里加一条 `prototypes/../x` 或别的路径，恢复被拒。
  - [ ] 不带原型的需求，备份和恢复的结果与现在一样，现有备份测试全部通过。
