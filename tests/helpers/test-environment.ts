import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { temporaryRoot } from "./temporary-root.ts";

const root = temporaryRoot();
process.env.TMPDIR = join(root, "verification");
process.env.GIT_CEILING_DIRECTORIES = root.replace(/\/$/, "");
mkdirSync(process.env.TMPDIR, { recursive: true });
