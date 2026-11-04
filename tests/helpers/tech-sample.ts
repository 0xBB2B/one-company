import type { TechItem } from "../../src/modules/interaction/tech-list.ts";

export const TECHS: TechItem[] = [
  { name: "PostgreSQL", kind: "数据库", source: "AI 提议", purpose: "保存用户和验证码记录", necessity: "需要事务和唯一约束", alternatives: "SQLite 不支持多进程同时写" },
  { name: "ioredis", kind: "第三方库", source: "项目规范", purpose: "限制验证码发送频率", necessity: "要跨进程共享计数", alternatives: "进程内计数在多实例下失效" },
];
