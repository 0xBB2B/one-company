import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const PARENT_BINDING_ENV = "ONE_COMPANY_TEST_PARENT_BINDING";
const ROOT_PROPERTY = "__oneCompanyTestTemporaryRoot";
const STATE_PROPERTY = "__oneCompanyTestTemporaryRootState";
const NON_OWNER_PROPERTY = "__oneCompanyTestTemporaryRootNonOwner";

type ParentBinding = { path: string; dev: bigint; ino: bigint };
type TemporaryRootState =
  | Readonly<{ mode: "default" }>
  | Readonly<{ mode: "managed"; bindingText: string }>;
type TestProcess = NodeJS.Process & {
  [ROOT_PROPERTY]?: string;
  [STATE_PROPERTY]?: unknown;
  [NON_OWNER_PROPERTY]?: unknown;
};

function managedBinding(bindingText: string): ParentBinding {
  let value: unknown;
  try {
    value = JSON.parse(bindingText);
  } catch {
    throw new Error(`${PARENT_BINDING_ENV} must be valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${PARENT_BINDING_ENV} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "dev" || keys[1] !== "ino" || keys[2] !== "path") {
    throw new Error(`${PARENT_BINDING_ENV} must contain only path, dev, and ino`);
  }
  if (typeof record.path !== "string" || !isAbsolute(record.path)) {
    throw new Error(`${PARENT_BINDING_ENV}.path must be an absolute canonical path`);
  }
  if (typeof record.dev !== "string" || !/^\d+$/.test(record.dev)
    || typeof record.ino !== "string" || !/^\d+$/.test(record.ino)) {
    throw new Error(`${PARENT_BINDING_ENV} dev and ino must be decimal strings`);
  }
  return { path: record.path, dev: BigInt(record.dev), ino: BigInt(record.ino) };
}

function validateManagedRoot(bindingText: string): string {
  const binding = managedBinding(bindingText);
  const stats = lstatSync(binding.path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${PARENT_BINDING_ENV}.path must identify a regular directory`);
  }
  if (realpathSync(binding.path) !== binding.path) {
    throw new Error(`${PARENT_BINDING_ENV}.path must be canonical`);
  }
  if (typeof process.getuid !== "function" || stats.uid !== BigInt(process.getuid())) {
    throw new Error(`${PARENT_BINDING_ENV}.path must be owned by the current uid`);
  }
  if ((stats.mode & 0o7777n) !== 0o700n) {
    throw new Error(`${PARENT_BINDING_ENV}.path must have mode 0700`);
  }
  if (stats.dev !== binding.dev || stats.ino !== binding.ino) {
    throw new Error(`${PARENT_BINDING_ENV}.path identity changed`);
  }
  return binding.path;
}

function ownsProperty(target: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, property);
}

function hasNonOwnerPreservation(testProcess: TestProcess): boolean {
  return ownsProperty(testProcess, NON_OWNER_PROPERTY);
}

function latchNonOwnerPreservation(testProcess: TestProcess): void {
  const existing = Object.getOwnPropertyDescriptor(testProcess, NON_OWNER_PROPERTY);
  if (existing) {
    if (!("value" in existing) || existing.value !== true
      || existing.writable !== false || existing.configurable !== false) {
      if (existing.configurable || ("value" in existing && existing.writable)) {
        // 无效标记固定为拒绝状态；属性存在即保全，不能由移除普通数据解除。
        Object.defineProperty(testProcess, NON_OWNER_PROPERTY, {
          value: false,
          writable: false,
          configurable: false,
          enumerable: existing.enumerable,
        });
      }
      throw new Error("temporary root non-owner preservation state is invalid");
    }
    return;
  }
  Object.defineProperty(testProcess, NON_OWNER_PROPERTY, {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

function readTemporaryRootState(testProcess: TestProcess): TemporaryRootState | null | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(testProcess, STATE_PROPERTY);
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || descriptor.writable !== false || descriptor.configurable !== false) {
    return null;
  }
  const value: unknown = descriptor.value;
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.mode === "default" && keys.length === 1 && keys[0] === "mode") {
    return value as TemporaryRootState;
  }
  if (record.mode === "managed" && typeof record.bindingText === "string"
    && keys.length === 2 && keys[0] === "bindingText" && keys[1] === "mode") {
    return value as TemporaryRootState;
  }
  return null;
}

function temporaryRootState(testProcess: TestProcess): TemporaryRootState {
  const bindingText = process.env[PARENT_BINDING_ENV];
  if (bindingText !== undefined) latchNonOwnerPreservation(testProcess);

  const existing = readTemporaryRootState(testProcess);
  if (existing === null) throw new Error("temporary root state is invalid");
  if (bindingText === undefined && hasNonOwnerPreservation(testProcess) && existing?.mode !== "managed") {
    throw new Error("temporary root non-owner preservation forbids default allocation");
  }
  if (existing) {
    if (existing.mode === "managed" && bindingText !== existing.bindingText) {
      throw new Error(`${PARENT_BINDING_ENV} changed after first use`);
    }
    if (existing.mode === "default" && bindingText !== undefined) {
      throw new Error(`${PARENT_BINDING_ENV} cannot be added after first use`);
    }
    return existing;
  }

  const state: TemporaryRootState = Object.freeze(bindingText === undefined
    ? { mode: "default" as const }
    : { mode: "managed" as const, bindingText });
  Object.defineProperty(testProcess, STATE_PROPERTY, {
    value: state,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return state;
}

export function isTemporaryRootManaged(): boolean {
  const testProcess = process as TestProcess;
  const state = readTemporaryRootState(testProcess);
  return process.env[PARENT_BINDING_ENV] !== undefined
    || hasNonOwnerPreservation(testProcess)
    || state === null
    || state?.mode === "managed";
}

export function cleanupTemporaryRoot(): void {
  const testProcess = process as TestProcess;
  if (process.env[PARENT_BINDING_ENV] !== undefined) {
    try {
      latchNonOwnerPreservation(testProcess);
      temporaryRootState(testProcess);
    } catch {
      // 未知或损坏的受控配置/状态只允许保全，不能转入默认删除路径。
    }
    return;
  }
  if (hasNonOwnerPreservation(testProcess)) return;

  let state: TemporaryRootState;
  try {
    state = temporaryRootState(testProcess);
  } catch {
    return;
  }
  if (state.mode !== "default") return;

  const root = testProcess[ROOT_PROPERTY];
  if (!root) return;
  try {
    rmdirSync(root);
    delete testProcess[ROOT_PROPERTY];
  } catch {
    // 非空目录保留，用于暴露未收尾的夹具或子进程。
  }
}

export function temporaryRoot(): string {
  const testProcess = process as TestProcess;
  const state = temporaryRootState(testProcess);
  if (state.mode === "managed") {
    const root = validateManagedRoot(state.bindingText);
    const cachedRoot = testProcess[ROOT_PROPERTY];
    if (cachedRoot !== undefined && cachedRoot !== root) {
      throw new Error("managed temporary root does not match the existing process cache");
    }
    return root;
  }

  if (testProcess[ROOT_PROPERTY]) return testProcess[ROOT_PROPERTY];
  const root = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-t-")));
  chmodSync(root, 0o700);
  const runRegistry = process.env.ONE_COMPANY_TEST_RUN_ROOT;
  if (runRegistry) writeFileSync(join(runRegistry, basename(root)), "");
  testProcess[ROOT_PROPERTY] = root;
  process.once("exit", cleanupTemporaryRoot);
  return root;
}
