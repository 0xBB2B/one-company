#!/usr/bin/env node
import { daemonLoader } from "../daemon/loader.mjs";

const { runSpecCheck } = await daemonLoader.import(new URL("../runtime/spec-check.ts", import.meta.url).href);
const result = await runSpecCheck(process.argv[2] ?? process.cwd());
for (const line of result.lines) (result.ok ? console.log : console.error)(line);
process.exitCode = result.ok ? 0 : 1;
