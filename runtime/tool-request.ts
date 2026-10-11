import { Type } from "typebox";
import type { TObject, TSchema } from "typebox";
import { Value } from "typebox/value";

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * 按动作分开定义的工具参数：{ request: 某个动作的参数 }。
 * 提供方要求参数最外层是对象，联合只能放在一层之内；平铺的全可选字段会让模型把各动作的字段都填上。
 */
export function requestParameters<T extends TObject[]>(variants: [...T]) {
  return Type.Object({ request: Type.Union(variants) }, { additionalProperties: false });
}

export function unwrapRequest(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw);
  return keys.length === 1 && keys[0] === "request" ? (raw as { request: unknown }).request : undefined;
}

/** 参数不合格时给模型的改正提示：只含字段名，不回显任何值。 */
export function shapeIssue(schema: TObject, value: unknown): string {
  const properties = schema.properties as Record<string, TSchema>;
  const allowed = Object.keys(properties);
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const extra = Object.keys(row).filter((key) => !Object.hasOwn(properties, key));
  const shown = extra.filter((key) => FIELD_NAME.test(key)), hidden = extra.length - shown.length;
  const missing = (schema.required ?? []).filter((key) => !Object.hasOwn(row, key));
  const invalid = allowed.filter((key) => Object.hasOwn(row, key) && !Value.Check(properties[key]!, row[key]));
  const parts = [
    extra.length ? `多余字段：${[...shown, ...(hidden ? [`另有 ${hidden} 个非法字段名`] : [])].join("、")}` : "",
    missing.length ? `缺少字段：${missing.join("、")}` : "",
    invalid.length ? `字段值格式不符：${invalid.join("、")}` : "",
    `本动作允许字段：${allowed.join("、")}`,
  ];
  return parts.filter(Boolean).join("；");
}
