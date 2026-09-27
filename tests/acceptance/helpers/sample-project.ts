import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const rules = (feature: { id: string; title: string }, rule: Record<string, unknown>) =>
  `${JSON.stringify({ $schema: "../schema.json", schemaVersion: 1, feature: { ...feature, aliases: [] }, rules: [{ dependsOn: [], exceptions: [], ...rule }] }, null, 2)}\n`;

export const SAMPLE_FILES: Record<string, string> = {
  "README.md": "# 样例小游戏\n\n角色可以左右移动和跳跃。运行 `npm test` 执行单元测试（node --test）。\n",
  "package.json": `${JSON.stringify({ name: "sample-game", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/player/movement.ts": [
    "export const WALK_SPEED = 4;",
    "",
    "export interface MoveInput { left: boolean; right: boolean }",
    "",
    "/** 每帧水平速度：只按一个方向键时朝该方向走，同时按或都不按时停下。 */",
    "export function horizontalVelocity(input: MoveInput): number {",
    "  if (input.left === input.right) return 0;",
    "  return input.right ? WALK_SPEED : -WALK_SPEED;",
    "}",
    "",
  ].join("\n"),
  "src/player/jump.ts": [
    "export interface JumpState { grounded: boolean; verticalSpeed: number }",
    "",
    "export const JUMP_SPEED = 10;",
    "",
    "export function pressJump(state: JumpState): JumpState {",
    "  if (!state.grounded) return state;",
    "  return { grounded: false, verticalSpeed: JUMP_SPEED };",
    "}",
    "",
  ].join("\n"),
  "src/player/movement.test.ts": [
    "import { test } from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { horizontalVelocity, WALK_SPEED } from \"./movement.ts\";",
    "import { pressJump } from \"./jump.ts\";",
    "",
    "test(\"按右键向右走，同时按两个方向键停下\", () => {",
    "  assert.equal(horizontalVelocity({ left: false, right: true }), WALK_SPEED);",
    "  assert.equal(horizontalVelocity({ left: true, right: true }), 0);",
    "});",
    "",
    "test(\"空中再次按跳跃不重新起跳\", () => {",
    "  const airborne = pressJump({ grounded: true, verticalSpeed: 0 });",
    "  assert.deepEqual(pressJump({ ...airborne, verticalSpeed: 3 }), { ...airborne, verticalSpeed: 3 });",
    "});",
    "",
  ].join("\n"),
  "go/greet/greet.go": "package greet\n\n// Greet 返回玩家进入游戏时的欢迎语。\nfunc Greet(name string) string {\n\treturn \"欢迎，\" + name\n}\n",
  "go/main.go": "package main\n\nimport (\n\t\"fmt\"\n\n\t\"sample-game/go/greet\"\n)\n\nfunc main() {\n\tfmt.Println(greet.Greet(\"玩家\"))\n}\n",
  "go/go.mod": "module sample-game/go\n\ngo 1.22\n",
  "docs/spec/player/horizontal-movement.rules.json": rules({ id: "player.horizontal-movement", title: "水平移动" }, {
    id: "player.horizontal-movement.walk", title: "方向键控制水平行走", condition: "角色在地面或空中", trigger: "只按下左键或右键",
    expected: "角色以行走速度朝按下的方向水平移动；同时按两个方向键或都不按时水平速度为零", reason: "玩家用方向键控制角色左右移动",
    acceptance: [{ id: "walk-right", given: "角色静止", when: "只按右键", then: "水平速度为正的行走速度" },
      { id: "both-keys", given: "角色静止", when: "同时按左键和右键", then: "水平速度为零" }],
  }),
  "docs/spec/player/jump-motion.rules.json": rules({ id: "player.jump-motion", title: "跳跃运动" }, {
    id: "player.jump-motion.single-airborne", title: "空中禁止重复起跳", condition: "角色处于空中", trigger: "再次按下跳跃",
    expected: "不开始新的跳跃过程，竖直速度保持不变", reason: "一次跳跃落地后才能再次起跳",
    acceptance: [{ id: "ignore-airborne-input", given: "角色已经起跳且尚未落地", when: "再次按跳跃", then: "没有新增一次起跳" }],
  }),
};

/** 在 root 下建一个带初始提交的样例项目 Git 仓库，返回仓库路径。 */
export async function createSampleProject(root: string): Promise<string> {
  const repo = join(root, "game");
  for (const [path, content] of Object.entries(SAMPLE_FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  const git = (...args: string[]) => exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", ...args], { cwd: repo });
  await git("init", "-q", "--initial-branch=main");
  await git("add", ".");
  await git("commit", "-qm", "样例小游戏：水平移动与跳跃");
  return repo;
}
