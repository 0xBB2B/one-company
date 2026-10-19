# stale-maintenance-marker 实施计划
## 阶段 1：自动清除
- [auto-clear-marker](01-auto-clear-marker.md) — 打开数据库或开始维护时清掉进程已不在的残留标记；清不了时报错写明原因和办法
## 阶段 2：清理
- [remove-takeover](02-remove-takeover.md) — 删除被自动清取代的接管写法 [依赖: auto-clear-marker]
