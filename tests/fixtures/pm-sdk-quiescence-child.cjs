'use strict';

const fs = require('node:fs');

const AUTHORIZATION = '--authorize=M4-PM-Q2-B1-FD-MINIMAL';
const CASE_PREFIX = '--case=';
const CASES = new Set(['normal', 'partial', 'closed-fd']);
const FD = 3;
const LENGTH_PREFIX_BYTES = 2;
const MAX_FRAME_BYTES = 256;
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - LENGTH_PREFIX_BYTES;

/** @returns {'normal' | 'partial' | 'closed-fd' | null} */
function parseCase() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== AUTHORIZATION || !args[1].startsWith(CASE_PREFIX)) {
    return null;
  }

  const caseName = args[1].slice(CASE_PREFIX.length);
  return CASES.has(caseName) ? /** @type {'normal' | 'partial' | 'closed-fd'} */ (caseName) : null;
}

/** @param {import('node:fs').Stats} stats */
function classify(stats) {
  if (stats.isSocket()) return 'socket';
  if (stats.isFIFO()) return 'fifo';
  if (stats.isFile()) return 'file';
  if (stats.isCharacterDevice()) return 'character';
  if (stats.isBlockDevice()) return 'block';
  return 'other';
}

/** @param {string} payload */
function makeFrame(payload) {
  const body = Buffer.from(payload, 'ascii');
  if (body.length > MAX_PAYLOAD_BYTES) {
    throw new Error('payload-too-large');
  }

  const frame = Buffer.allocUnsafe(body.length + LENGTH_PREFIX_BYTES);
  frame.writeUInt16BE(body.length, 0);
  body.copy(frame, LENGTH_PREFIX_BYTES);
  return frame;
}

/** @param {string} payload */
function writeFrame(payload) {
  const frame = makeFrame(payload);
  const written = fs.writeSync(FD, frame);
  if (written !== frame.length) {
    throw new Error('short-write');
  }
  return written;
}

const caseName = parseCase();
if (caseName === null) {
  process.exitCode = 64;
} else {
  try {
    const descriptorType = classify(fs.fstatSync(FD));
    writeFrame(`META:1:${descriptorType}`);

    if (caseName === 'normal') {
      const dataWriteReturn = writeFrame('DATA:2:probe');
      writeFrame(`ACK:3:${dataWriteReturn}`);
      fs.closeSync(FD);
      process.exitCode = 0;
    } else if (caseName === 'partial') {
      const partialFrame = Buffer.from([0x00, 0x08, 0x58]);
      const written = fs.writeSync(FD, partialFrame);
      if (written !== partialFrame.length) {
        throw new Error('short-partial-write');
      }
      fs.closeSync(FD);
      process.exitCode = 20;
    } else {
      fs.closeSync(FD);
      try {
        fs.writeSync(FD, makeFrame('DATA:2:probe'));
        process.exitCode = 1;
      } catch (error) {
        process.exitCode = error instanceof Error && 'code' in error && error.code === 'EBADF' ? 21 : 1;
      }
    }
  } catch {
    process.exitCode = 1;
  }
}
