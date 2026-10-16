export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class JsonFormatError extends Error {
  readonly code: "invalid_json" | "duplicate_key" | "invalid_unicode";
  constructor(code: JsonFormatError["code"], offset: number) {
    super(`JSON 格式检查失败：${code}，位置 ${offset}`);
    this.name = "JsonFormatError"; this.code = code;
  }
}

function validUnicode(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

/** 严格解析 JSON，按解码后的键拒绝重复项，不采用最后写入覆盖。 */
export function parseStrictJson(source: string): JsonValue {
  let offset = 0;
  const fail = (code: JsonFormatError["code"] = "invalid_json"): never => { throw new JsonFormatError(code, offset); };
  const whitespace = () => { while (/^[\t\n\r ]$/.test(source[offset] ?? "")) offset++; };
  function string(): string {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++]!;
      if (char === '"') {
        let value: string;
        try { value = JSON.parse(source.slice(start, offset)); } catch { return fail(); }
        if (!validUnicode(value)) return fail("invalid_unicode");
        return value;
      }
      if (char === "\\") offset++;
      else if (char.charCodeAt(0) < 32) return fail();
    }
    return fail();
  }
  function value(depth: number): JsonValue {
    whitespace();
    // 固定协议只有少量嵌套；畸形输入不能耗尽调用栈。
    if (depth > 64) return fail();
    const char = source[offset];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      offset++; whitespace();
      const object = Object.create(null) as Record<string, JsonValue>;
      const array: JsonValue[] = [];
      const end = char === "{" ? "}" : "]";
      if (source[offset] !== end) {
        for (;;) {
          whitespace();
          if (char === "{") {
            if (source[offset] !== '"') return fail();
            const key = string();
            if (Object.hasOwn(object, key)) return fail("duplicate_key");
            whitespace();
            if (source[offset++] !== ":") return fail();
            object[key] = value(depth + 1);
          } else array.push(value(depth + 1));
          whitespace();
          if (source[offset] === end) break;
          if (source[offset++] !== ",") return fail();
        }
      }
      offset++;
      return char === "{" ? object : array;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(offset))?.[0];
    if (!token) return fail();
    offset += token.length;
    const parsed = JSON.parse(token) as JsonValue;
    if (typeof parsed === "number" && !Number.isFinite(parsed)) return fail();
    return parsed;
  }
  const result = value(0);
  whitespace();
  if (offset !== source.length) return fail();
  return result;
}

/** 对象键固定排序，数组保序；不忽略字段、不修剪文本、不做 Unicode 归一化。 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("内容指纹不接受非有限数值");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!validUnicode(value)) throw new Error("内容指纹不接受孤立代理码点");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalJson(item)).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("内容指纹只接受 JSON 值");
  return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}
