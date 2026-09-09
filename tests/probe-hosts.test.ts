import { describe, expect, test } from "bun:test";
import { toValidHostUrl } from "../runtime/network-pause.ts";

describe("探测目标 baseUrl 校验", () => {
  test("合法的完整 https URL 通过", () => {
    expect(toValidHostUrl("https://api.example.com/")?.href).toBe("https://api.example.com/");
    expect(toValidHostUrl("https://api.example.com:8443/")?.href).toBe("https://api.example.com:8443/");
  });

  test("合法的完整 http URL 通过", () => {
    expect(toValidHostUrl("http://localhost:11434/")?.href).toBe("http://localhost:11434/");
  });

  test("含 userinfo（用户名或密码）的 URL 判非法", () => {
    expect(toValidHostUrl("https://user:pass@api.example.com/")).toBeNull();
    expect(toValidHostUrl("https://user@api.example.com/")).toBeNull();
  });

  test("协议不是 http/https 时判非法", () => {
    expect(toValidHostUrl("ftp://api.example.com/")).toBeNull();
    expect(toValidHostUrl("ws://api.example.com/")).toBeNull();
    expect(toValidHostUrl("file:///etc/passwd")).toBeNull();
  });

  test("无法解析为合法 URL 时判非法", () => {
    expect(toValidHostUrl("not a url")).toBeNull();
    expect(toValidHostUrl("evil.com/@real.com")).toBeNull();
    expect(toValidHostUrl("api.example.com")).toBeNull();
    expect(toValidHostUrl("")).toBeNull();
  });
});
