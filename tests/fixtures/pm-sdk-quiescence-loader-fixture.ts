import {
  execFile,
  spawn,
  type ExecFileOptionsWithStringEncoding,
  type SpawnOptions,
} from 'node:child_process';

export const originalSpawn = spawn;
export const originalExecFile = execFile;

export function spawnNodeVersion(file: string, args: string[], options: SpawnOptions) {
  return spawn(file, args, options);
}

export function execFileNodeVersion(
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) {
  return execFile(file, args, options, callback);
}
