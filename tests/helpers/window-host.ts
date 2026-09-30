import type { WindowHost } from "../../runtime/question-window.ts";

const DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";
const plainTheme = { fg: (_kind: string, text: string) => text, bold: (text: string) => text };

export interface ShownWindow { title: string; text: string; choices: string[] }

/** 渲染程序窗口交给 answer 判断：true 选确认，false 按 Esc，字符串选同名选项。 */
export function answeringUi(answer: (window: ShownWindow) => boolean | string | Promise<boolean | string>): WindowHost["ui"] {
  return {
    custom<T>(factory: (...args: never[]) => unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const component = (factory as (...args: unknown[]) => unknown)({ requestRender() {} }, plainTheme, undefined, resolve) as
          { render(width: number): string[]; handleInput(data: string): void };
        const lines = component.render(200).map((line) => line.trimEnd());
        const end = lines.lastIndexOf(""), start = lines.lastIndexOf("", end - 1);
        const choices = lines.slice(start + 1, end).map((line) => line.replace(/^ (→ | {2})/u, "").split(/ {2,}/u)[0]!);
        const shown = { title: lines[1]!.trim(), text: lines.join("\n"), choices };
        void Promise.resolve(answer(shown)).then((decision) => {
          if (decision === false) { component.handleInput(ESC); return; }
          const index = decision === true ? choices.indexOf("确认") : choices.indexOf(decision);
          if (index < 0) throw new Error(`窗口里没有选项：${String(decision)}`);
          for (let i = 0; i < index; i++) component.handleInput(DOWN);
          component.handleInput(ENTER);
        }).catch(reject);
      });
    },
  } as unknown as WindowHost["ui"];
}
