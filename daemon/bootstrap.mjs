import { daemonLoader } from "./loader.mjs";

const startupConfigModule = await daemonLoader.import(
  new URL("../runtime/daemon-startup-config.ts", import.meta.url).href,
);
const capturedEnv = { ...process.env };
const startupConfig = startupConfigModule.parseDaemonStartupConfig(capturedEnv);
const gitRuntime = await daemonLoader.import(new URL("../runtime/git-runtime.mjs", import.meta.url).href);
const gitBinding = await daemonLoader.import(new URL("../runtime/git-daemon-binding.ts", import.meta.url).href);

if (Object.hasOwn(capturedEnv, "PI_COMPANY_EXPECTED_GIT")) {
  const expected = gitBinding.decodeGitExpectation(capturedEnv.PI_COMPANY_EXPECTED_GIT);
  gitRuntime.initializeInheritedGit(expected, startupConfig.ownRoots);
} else {
  gitRuntime.initializeHostGit(startupConfig.ownRoots);
}

gitRuntime.currentHostGit(startupConfig.ownRoots);
await daemonLoader.import(new URL("./main.ts", import.meta.url).href);
