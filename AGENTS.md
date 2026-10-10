# 项目代理指令

## 测试

- 纯代码测试（`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation`）在当前基线上跑一遍、全部通过即可。
- `tests/acceptance/` 下的真实模型验收彼此没有先后关系，一律同时跑：`ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel [--repeat <次数>] [--only <编号…>]`。每条跑几次按当时需要用 `--repeat` 指定，默认 1 次；某次 10 分钟没有任何更新会被自动停下。
