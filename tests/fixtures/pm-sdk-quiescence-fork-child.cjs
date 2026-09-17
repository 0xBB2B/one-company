'use strict';
// @ts-check

let failed = false;
let writeCallbackCalls = 0;
let sendCallbackCalls = 0;
let disconnectAttempted = false;

function disconnectOnce() {
  if (disconnectAttempted || process.connected !== true || typeof process.disconnect !== 'function') return;
  disconnectAttempted = true;
  try {
    process.disconnect();
  } catch {
    process.exitCode = 1;
  }
}

function fail() {
  failed = true;
  process.exitCode = 1;
  disconnectOnce();
}

if (typeof process.send !== 'function' || process.connected !== true) {
  process.exitCode = 64;
} else {
  try {
    process.stdout.on('error', fail);
    process.on('error', fail);
    process.stdout.write(`${process.version}\n`, (/** @type {unknown} */ error) => {
      writeCallbackCalls += 1;
      if (writeCallbackCalls !== 1 || error !== null && error !== undefined) {
        fail();
        return;
      }
      if (failed || typeof process.send !== 'function' || process.connected !== true) {
        fail();
        return;
      }
      try {
        process.send({ type: 'ready', version: 1 }, (/** @type {unknown} */ sendError) => {
          sendCallbackCalls += 1;
          if (sendCallbackCalls !== 1 || sendError !== null && sendError !== undefined) {
            fail();
            return;
          }
          if (failed || typeof process.disconnect !== 'function' || process.connected !== true) {
            fail();
            return;
          }
          disconnectOnce();
        });
      } catch {
        fail();
      }
    });
  } catch {
    fail();
  }
}
