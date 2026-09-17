import assert from "node:assert/strict";
import { test } from "vitest";
import { guardState, PRELOAD_URL, TEST_NAME } from "../helpers/pm-sdk-ab-owner.mjs";

const PARENT_BINDING = "PI_COMPANY_TEST_PARENT_BINDING";

test(TEST_NAME, () => {
  const state = guardState();
  assert.deepEqual(state, {
    role: "B",
    intact: true,
    failed: false,
    sealed: true,
    admitted: false,
  });

  const descriptor = Object.getOwnPropertyDescriptor(process.env, PARENT_BINDING);
  assert.ok(descriptor && "value" in descriptor && typeof descriptor.value === "string");
  const binding: unknown = JSON.parse(descriptor.value);
  assert.ok(binding && typeof binding === "object" && !Array.isArray(binding));
  const fields = Object.getOwnPropertyDescriptors(binding);
  const bindingKeys = Reflect.ownKeys(binding).sort();
  assert.equal(bindingKeys.length, 3);
  assert.equal(bindingKeys[0], "dev");
  assert.equal(bindingKeys[1], "ino");
  assert.equal(bindingKeys[2], "path");
  assert.ok("value" in fields.path && typeof fields.path.value === "string");
  assert.ok("value" in fields.dev && typeof fields.dev.value === "string" && /^\d+$/u.test(fields.dev.value));
  assert.ok("value" in fields.ino && typeof fields.ino.value === "string" && /^\d+$/u.test(fields.ino.value));
  const root = fields.path.value;

  assert.equal(process.env.HOME, `${root}/home`);
  assert.equal(process.env.PI_CODING_AGENT_DIR, `${root}/home/.pi/agent`);
  assert.equal(process.env.XDG_CONFIG_HOME, `${root}/home/.config`);
  assert.equal(process.env.XDG_CACHE_HOME, `${root}/home/.cache`);
  assert.equal(process.env.TMPDIR, `${root}/verification`);
  assert.equal(process.env.GIT_CEILING_DIRECTORIES, root);
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.TEST, "true");
  assert.equal(process.env.VITEST, "true");
  assert.equal(process.env.VITEST_MODE, "RUN");
  assert.equal(process.env.PI_PM_AB_ROLE, "B");
  assert.equal(process.env.PI_PM_AB_PRELOAD, PRELOAD_URL);
  assert.equal(process.connected, true);

  const preloadPositions = process.execArgv
    .map((value, index) => value === "--import" && process.execArgv[index + 1] === PRELOAD_URL ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(preloadPositions.length, 1);
  assert.equal(preloadPositions[0], process.execArgv.length - 2);
  const repeated = guardState();
  assert.ok(repeated);
  assert.equal(repeated.role, state.role);
  assert.equal(repeated.intact, state.intact);
  assert.equal(repeated.failed, state.failed);
  assert.equal(repeated.sealed, state.sealed);
  assert.equal(repeated.admitted, state.admitted);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(repeated), true);
});
