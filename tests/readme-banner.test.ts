import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BANNER = join(PACKAGE_ROOT, "assets/onecompany-banner.webp");
const MAX_BYTES = 204800;

function readWebpSize(buffer: Buffer): { width: number; height: number } {
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk !== "VP8 ") throw new Error(`横幅图应是有损 webp，实际块类型：${chunk}`);
  return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
}

describe("README 横幅图", () => {
  const buffer = readFileSync(BANNER);

  test("文件头是 RIFF/WEBP", () => {
    expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buffer.toString("ascii", 8, 12)).toBe("WEBP");
  });

  test("宽 1600、高 560", () => {
    expect(readWebpSize(buffer)).toEqual({ width: 1600, height: 560 });
  });

  test("文件不超过 200 KB", () => {
    expect(buffer.length).toBeLessThanOrEqual(MAX_BYTES);
  });

  test("assets 目录里被 git 跟踪的只有横幅图一个文件", () => {
    const tracked = execFileSync("git", ["ls-files", "assets"], { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim().split("\n");
    expect(tracked).toEqual(["assets/onecompany-banner.webp"]);
  });
});
