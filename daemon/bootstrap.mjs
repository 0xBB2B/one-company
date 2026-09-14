import { daemonLoader } from "./loader.mjs";

await daemonLoader.import(new URL("./main.ts", import.meta.url).href);
