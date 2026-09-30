import type { WindowHost } from "../../runtime/question-window.ts";

const UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";
const plainTheme = { fg: (_kind: string, text: string) => text, bold: (text: string) => text };

export interface ShownWindow { title: string; text: string; choices: string[] }
/** true 选确认，false 按 Esc，字符串选同名选项，{ other } 在"其他（自己输入）"里输入文字。 */
export type WindowDecision = boolean | string | { other: string };

/** 渲染程序窗口或主代理提问窗口，交给 answer 判断怎么答。 */
export function answeringUi(answer: (window: ShownWindow) => WindowDecision | Promise<WindowDecision>): WindowHost["ui"] {
  return {
    custom<T>(factory: (...args: never[]) => unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const component = (factory as (...args: unknown[]) => unknown)({ requestRender() {} }, plainTheme, undefined, resolve) as
          { render(width: number): string[]; handleInput(data: string): void };
        const lines = component.render(200).map((line) => line.trimEnd());
        // 选项行以" → "或三个空格开头；理由、推荐理由与折行续行缩进更深，不算选项
        const rows = lines.filter((line) => /^ (?:→ | {2})\S/u.test(line));
        const choices = rows.map((line) => line.slice(3).replace(/^\[.\] /u, "").replace(/^\d+\. /u, "").split(/ {2,}/u)[0]!);
        const cursor = rows.findIndex((line) => line.startsWith(" → "));
        const shown = { title: lines[1]!.trim(), text: lines.join("\n"), choices };
        void Promise.resolve(answer(shown)).then((decision) => {
          if (decision === false) { component.handleInput(ESC); return; }
          const label = decision === true ? "确认" : typeof decision === "string" ? decision : "其他（自己输入）";
          const index = choices.indexOf(label);
          if (index < 0) throw new Error(`窗口里没有选项：${label}`);
          for (let i = cursor; i < index; i++) component.handleInput(DOWN);
          for (let i = cursor; i > index; i--) component.handleInput(UP);
          component.handleInput(ENTER);
          if (typeof decision === "object") { for (const char of decision.other) component.handleInput(char); component.handleInput(ENTER); }
        }).catch(reject);
      });
    },
  } as unknown as WindowHost["ui"];
}
