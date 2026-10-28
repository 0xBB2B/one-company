export interface UpgradeNotice {
  kind: "replaced" | "waiting_usable" | "waiting_blocked" | "replaced_after_wait" | "window_stale";
  repoName: string;
  requirements: string[];
  otherWindows: number;
  ownSessions: number;
}

export interface UpgradeNoticeText {
  text: string;
  level: "info" | "warning" | "error";
}

function requirementList(requirements: string[]): string {
  return `需求${requirements.map((name) => `「${name}」`).join("")}`;
}

function busyItems(notice: UpgradeNotice): string[] {
  const items: string[] = [];
  if (notice.requirements.length > 0) items.push(`${requirementList(notice.requirements)}在运行`);
  if (notice.otherWindows > 0) items.push(`另有 ${notice.otherWindows} 个窗口连着`);
  if (notice.ownSessions > 0) items.push("本窗口有原型设计或检索在跑");
  return items;
}

function waitItems(notice: UpgradeNotice): string[] {
  const items: string[] = [];
  if (notice.requirements.length > 0) items.push(`${requirementList(notice.requirements)}运行结束`);
  if (notice.otherWindows > 0) items.push(`另外 ${notice.otherWindows} 个窗口关闭`);
  if (notice.ownSessions > 0) items.push("本窗口的原型设计或检索跑完");
  return items;
}

export function upgradeNoticeText(notice: UpgradeNotice): UpgradeNoticeText {
  const name = notice.repoName;
  switch (notice.kind) {
    case "replaced":
      return { text: `${name} 的后台进程跑的是旧代码，已停掉并换成当前安装的版本。`, level: "info" };
    case "waiting_usable":
      return {
        text: `${name} 的后台进程跑的是旧代码，还在忙：${busyItems(notice).join("，")}。现在先照常用它，空下来后 30 秒内会自动换成新代码。`,
        level: "warning",
      };
    case "waiting_blocked":
      return {
        text: `${name} 的后台进程是旧版本，和这个窗口不兼容，需求和代理功能暂时用不了，普通对话不受影响。正在等：${waitItems(notice).join("，")}。空下来后 30 秒内会自动换成新版本。`,
        level: "warning",
      };
    case "replaced_after_wait":
      return { text: `${name} 的后台进程已换成新版本，需求和代理功能可以用了。`, level: "info" };
    case "window_stale":
      return {
        text: `这个窗口是旧版本，和${name} 已更新的后台进程不兼容，需求和代理功能用不了。请关掉这个窗口，运行 pi -c 重新打开，接着原来的对话。`,
        level: "error",
      };
  }
}

export function upgradeAdvice(notice: UpgradeNotice): { why: string; next: string } {
  if (notice.kind === "window_stale") {
    return {
      why: `这个窗口是旧版本，和${notice.repoName} 已更新的后台进程不兼容。`,
      next: "请用户关掉这个窗口，运行 pi -c 重新打开，接着原来的对话。",
    };
  }
  return {
    why: `${notice.repoName} 的后台进程是旧版本，和这个窗口不兼容；正在等${waitItems(notice).join("、")}后自动换成新版本。`,
    next: "告诉用户需求和代理功能要等后台换成新版本后才能用；换好后窗口里会有提示，再重试这一步。",
  };
}
