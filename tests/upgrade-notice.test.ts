import { describe, expect, test } from "vitest";
import { upgradeAdvice, upgradeNoticeText } from "../src/core/host/upgrade-notice.ts";
import type { UpgradeNotice } from "../src/core/host/upgrade-notice.ts";

function notice(kind: UpgradeNotice["kind"], rest: Partial<UpgradeNotice> = {}): UpgradeNotice {
  return { kind, repoName: "企微BOT", requirements: [], otherWindows: 0, ownSessions: 0, ...rest };
}

describe("升级提示文字", () => {
  test("replaced 是 info 级，文字逐字一致", () => {
    expect(upgradeNoticeText(notice("replaced"))).toEqual({
      text: "企微BOT 的后台进程跑的是旧代码，已停掉并换成当前安装的版本。",
      level: "info",
    });
  });

  test("waiting_usable 是 warning 级，需求项和窗口项用中文逗号连接", () => {
    expect(upgradeNoticeText(notice("waiting_usable", { requirements: ["A", "B"], otherWindows: 2 }))).toEqual({
      text: "企微BOT 的后台进程跑的是旧代码，还在忙：需求「A」「B」在运行，另有 2 个窗口连着。现在先照常用它，空下来后 30 秒内会自动换成新代码。",
      level: "warning",
    });
  });

  test("waiting_usable 只有窗口连着时不出现需求项", () => {
    const { text } = upgradeNoticeText(notice("waiting_usable", { otherWindows: 1 }));
    expect(text).toBe("企微BOT 的后台进程跑的是旧代码，还在忙：另有 1 个窗口连着。现在先照常用它，空下来后 30 秒内会自动换成新代码。");
    expect(text).not.toContain("需求");
  });

  test("waiting_usable 三项都有时顺序为需求、窗口、本窗口会话", () => {
    const { text } = upgradeNoticeText(notice("waiting_usable", { requirements: ["订单导出"], otherWindows: 3, ownSessions: 1 }));
    expect(text).toContain("还在忙：需求「订单导出」在运行，另有 3 个窗口连着，本窗口有原型设计或检索在跑。现在先照常用它");
  });

  test("waiting_usable 只有本窗口会话时只列这一项", () => {
    const { text } = upgradeNoticeText(notice("waiting_usable", { ownSessions: 2 }));
    expect(text).toContain("还在忙：本窗口有原型设计或检索在跑。现在先照常用它");
  });

  test("waiting_blocked 是 warning 级，等待原因用中文逗号连接且文字逐字一致", () => {
    expect(upgradeNoticeText(notice("waiting_blocked", { requirements: ["A", "B"], otherWindows: 2, ownSessions: 1 }))).toEqual({
      text: "企微BOT 的后台进程是旧版本，和这个窗口不兼容，需求和代理功能暂时用不了，普通对话不受影响。正在等：需求「A」「B」运行结束，另外 2 个窗口关闭，本窗口的原型设计或检索跑完。空下来后 30 秒内会自动换成新版本。",
      level: "warning",
    });
  });

  test("waiting_blocked 只列实际存在的等待项", () => {
    const { text } = upgradeNoticeText(notice("waiting_blocked", { otherWindows: 1 }));
    expect(text).toContain("正在等：另外 1 个窗口关闭。空下来后");
    expect(text).not.toContain("运行结束");
    expect(text).not.toContain("跑完");
  });

  test("replaced_after_wait 是 info 级，文字逐字一致", () => {
    expect(upgradeNoticeText(notice("replaced_after_wait"))).toEqual({
      text: "企微BOT 的后台进程已换成新版本，需求和代理功能可以用了。",
      level: "info",
    });
  });

  test("window_stale 是 error 级，文字逐字一致", () => {
    expect(upgradeNoticeText(notice("window_stale"))).toEqual({
      text: "这个窗口是旧版本，和企微BOT 已更新的后台进程不兼容，需求和代理功能用不了。请关掉这个窗口，运行 pi -c 重新打开，接着原来的对话。",
      level: "error",
    });
  });
});

describe("升级错误的原因与建议", () => {
  test("waiting_blocked 的原因用顿号连接各等待项，建议逐字一致", () => {
    expect(upgradeAdvice(notice("waiting_blocked", { requirements: ["订单导出"], otherWindows: 1 }))).toEqual({
      why: "企微BOT 的后台进程是旧版本，和这个窗口不兼容；正在等需求「订单导出」运行结束、另外 1 个窗口关闭后自动换成新版本。",
      next: "告诉用户需求和代理功能要等后台换成新版本后才能用；换好后窗口里会有提示，再重试这一步。",
    });
  });

  test("waiting_blocked 三项都有时顺序为需求、窗口、本窗口会话", () => {
    const { why } = upgradeAdvice(notice("waiting_blocked", { requirements: ["A", "B"], otherWindows: 2, ownSessions: 1 }));
    expect(why).toBe("企微BOT 的后台进程是旧版本，和这个窗口不兼容；正在等需求「A」「B」运行结束、另外 2 个窗口关闭、本窗口的原型设计或检索跑完后自动换成新版本。");
  });

  test("window_stale 的原因与建议逐字一致", () => {
    expect(upgradeAdvice(notice("window_stale"))).toEqual({
      why: "这个窗口是旧版本，和企微BOT 已更新的后台进程不兼容。",
      next: "请用户关掉这个窗口，运行 pi -c 重新打开，接着原来的对话。",
    });
  });
});
