# chance-reset 实施计划
## 阶段 1：计数规则
- [counting-cycle](01-counting-cycle.md) — 任务记录加计数周期和重算额度，修改任务按规则开新周期，派工与结局按当前周期计
## 阶段 2：面板与审查
- [panel-cycle](02-panel-cycle.md) — 裁决恢复额度，面板次数按周期，决策包加说明行和拆分选项说明 [依赖: counting-cycle]
- [rework-full-review](03-rework-full-review.md) — 返修后全部重审，去掉「上一轮已通过」，PM 规矩同步 [依赖: panel-cycle]
