import { describe, expect, test } from "bun:test";
import { toValidHostUrl } from "../daemon/probe.ts";

describe("探测目标主机校验", () => {
  test("带端口的主机合法且保留端口", () => {
    expect(toValidHostUrl("localhost:11434")?.href).toBe("https://localhost:11434/");
    expect(toValidHostUrl("api.example.com:8443")?.href).toBe("https://api.example.com:8443/");
  });

  test("含路径、用户信息或空白的主机非法", () => {
    for (const host of ["evil.com/@real.com", "user:pw@evil.com", "api.example.com/v1", "a b.com"]) {
      expect(toValidHostUrl(host)).toBeNull();
    }
  });
});
