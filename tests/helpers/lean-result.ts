import { expect } from "vitest";

export type ToolResponse = { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> };

export const sentOf = (response: ToolResponse): Record<string, any> => {
  expect(response.content).toHaveLength(1);
  expect(response.content[0]!.type).toBe("text");
  return JSON.parse(response.content[0]!.text);
};

export const pick = (source: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));

/** sent 与 kept 只列这次结果里实际存在的字段：content 只含 sent 加上 nested（嵌套对象里发给模型的那部分），details 两边都有。 */
export function expectLean(response: ToolResponse, sent: string[], kept: string[], nested: Record<string, unknown> = {}) {
  const content = sentOf(response), details = response.details!;
  expect(Object.keys(details)).toEqual(expect.arrayContaining([...sent, ...kept, ...Object.keys(nested)]));
  expect(content).toEqual({ ...pick(details, sent), ...nested });
  for (const key of kept) expect(content, key).not.toHaveProperty(key);
  return { content, details };
}
