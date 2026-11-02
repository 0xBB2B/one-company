# prototype-design-frame 实施计划

## 阶段 1：外框和交稿
- [frame-builder](01-frame-builder.md) — 新增把页面和清单拼成固定外框的纯函数
- [submit-flow](02-submit-flow.md) — 交稿工具收页面清单，检查后写入拼好的文件 [依赖: frame-builder]

## 阶段 2：规矩
- [role-rules](03-role-rules.md) — 改设计师、worker、reviewer、qa 的职责规矩

## 阶段 3：验收
- [p17-acceptance](04-p17-acceptance.md) — 新增真实模型验收 P17，同步验收文档 [依赖: submit-flow, role-rules]
