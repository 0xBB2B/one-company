import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 读取包内一层规范：rules 只给主窗口，shared 主窗口与子代理共用；按文件名顺序拼接。 */
export function loadPackageRules(layer: "rules" | "shared"): string {
	const dir = join(packageDir, layer);
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => readFileSync(join(dir, file), "utf8").trim())
		.join("\n\n");
}

export type RoleRulesName = "worker" | "prototype" | "worker-prototype" | "reviewer" | "qa" | "explore" | "pm";

/** 读取包内某个职责的流程规矩正文；worker-prototype 是 worker 做界面原型时用的另一份。 */
export function loadRoleRules(name: RoleRulesName): string {
	return readFileSync(join(packageDir, "role-rules", `${name}.md`), "utf8").trim();
}
