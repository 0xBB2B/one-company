// @ts-check

import { spawn, execFile, ChildProcess } from 'node:child_process';
import { errorMonitor } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPrototypeSpawnGuard } from './helpers/pm-sdk-quiescence-adapter.mjs';
import common from './pm-sdk-quiescence-creation-entry.cjs';

const {
  parseAuthorizedCase,
  expectedNodeVersion,
  runCreationCase,
  realClock,
  memoryFrameSink,
  createSafeOutputChannel,
} = common;

/**
 * The ESM path deliberately passes the actual static named imports above.
 * It never obtains spawn, execFile, or ChildProcess through the CJS module.
 * @param {any} bindings zero-process VM bindings, or the fixed real bindings
 */
export async function runEsmCreationEntry(bindings) {
  return runCreationCase({
    caseName: bindings.caseName,
    api: bindings.api,
    ChildProcess: bindings.ChildProcess,
    createPrototypeSpawnGuard: bindings.createPrototypeSpawnGuard,
    errorMonitor: bindings.errorMonitor,
    promisify: bindings.promisify,
    process: bindings.process,
    clock: bindings.clock,
    frameSink: bindings.frameSink,
    expectedVersion: bindings.expectedVersion,
    onProgress: bindings.onProgress,
    subscribeOutputFailure: bindings.subscribeOutputFailure,
  });
}

export async function esmMain() {
  const output = createSafeOutputChannel(process.stdout, process);
  const selectedCase = parseAuthorizedCase(process.argv.slice(2));
  if (selectedCase === null) {
    process.exitCode = 64;
    const written = await output.writeText('NOT_AUTHORIZED\n');
    if (!written || output.failed()) process.exitCode = 1;
    return;
  }
  const expectedVersion = expectedNodeVersion(process);
  if (expectedVersion === null) {
    process.exitCode = 1;
    await output.writeJson({ kind: 'configuration-rejected' });
    return;
  }
  if (output.failed()) return;
  const report = await runEsmCreationEntry({
    caseName: selectedCase,
    api: { spawn, execFile },
    ChildProcess,
    createPrototypeSpawnGuard,
    errorMonitor,
    promisify,
    process,
    clock: realClock(),
    frameSink: memoryFrameSink,
    expectedVersion,
    onProgress: (/** @type {Record<string, unknown>} */ value) => output.writeJson(value),
    subscribeOutputFailure: output.subscribe,
  });
  const written = await output.writeJson(report);
  if (!written || output.failed() || report.ok !== true) process.exitCode = 1;
  else if (process.exitCode !== 1) process.exitCode = 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  esmMain().catch(() => {
    process.exitCode = 1;
  });
}
