# authorize-implement 实施计划
## 阶段 1：补授权的数据与状态
- [manifest-supplement](01-manifest-supplement.md) — 在已登记的批准清单上只加一个实施动作，生成、核对并登记
- [state-service-authorize](02-state-service-authorize.md) — 需求记录改为引用补授权清单 [依赖: manifest-supplement]
## 阶段 2：解读与工具
- [interpret-implement](03-interpret-implement.md) — 解读核心只判断原话有没有明确授权实施 [依赖: manifest-supplement]
- [authorize-tool](04-authorize-tool.md) — 需求工具新增 authorizeImplement，串起窗口、解读、登记与服务 [依赖: state-service-authorize, interpret-implement]
## 阶段 3：批准时提醒
- [approval-result-and-rules](05-approval-result-and-rules.md) — 批准结果写明有没有授权实施，派 PM 被拒的建议指向补授权 [依赖: manifest-supplement, authorize-tool]
