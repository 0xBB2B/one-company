import { writeSync } from "node:fs";
import { extractCode, getCodeExtractorVersion } from "../../src/modules/project-index/code-extractor.ts";
import { ProjectIndexService } from "../../src/modules/project-index/project-index-service.ts";
import type { ProjectIndexExtractor } from "../../src/modules/project-index/project-index-service.ts";


interface Input {
  mode: "hang" | "count";
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
}

const encoded = process.argv[2];
if (!encoded) throw new Error("missing input");
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Input;
let parseCount = 0;
const extractor: ProjectIndexExtractor = {
  version: getCodeExtractorVersion,
  async extract(request) {
    parseCount++;
    if (input.mode === "hang") {
      writeSync(1, "EXTRACTOR_WAITING\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return extractCode(request);
  },
};
const service = await ProjectIndexService.open({
  repositoryRoot: input.repositoryRoot,
  dataRoot: input.dataRoot,
  repoId: input.repoId,
  authorize: () => true,
  extractor,
});
const result = await service.refresh();
writeSync(1, `${JSON.stringify({ parseCount, status: result.status, generation: result.generation })}\n`);
