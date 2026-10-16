import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

export interface MentionCandidate {
  requirementId: string;
  title: string;
  lifecycle: "draft" | "active";
  pmRunning: boolean;
  repoName: string;
}

const MIN_TAIL = 4;
const MENTION_QUERY = /(?:^|\s)@([^\s@[\]]*)$/u;

/** 每个需求取最短且不与其他候选重复的编号尾巴（至少 4 位），标题里的方括号换成全角以免打断 @[标题#编号尾] 记号。 */
export function mentionItems(candidates: readonly MentionCandidate[], multiRepo: boolean): AutocompleteItem[] {
  return candidates.map((candidate) => {
    let length = MIN_TAIL;
    while (length < candidate.requirementId.length &&
      candidates.some((other) => other !== candidate && other.requirementId.endsWith(candidate.requirementId.slice(-length)))) length++;
    const label = `@[${candidate.title.replaceAll("[", "［").replaceAll("]", "］")}#${candidate.requirementId.slice(-length)}]`;
    const description = ["需求", candidate.lifecycle === "draft" ? "草稿" : "进行中", ...(candidate.pmRunning ? ["PM 运行中"] : []),
      ...(multiRepo ? [candidate.repoName] : [])].join(" · ");
    return { value: `${label} `, label, description };
  });
}

/** 在 pi 自带补全外包一层：光标前是 @xxx 时，把标题或编号尾巴对得上的需求排在文件前面。 */
export function requirementMentionProvider(current: AutocompleteProvider, candidates: () => Promise<readonly MentionCandidate[]>,
  multiRepo: () => boolean): AutocompleteProvider {
  return {
    ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
    ...(current.shouldTriggerFileCompletion ? { shouldTriggerFileCompletion: current.shouldTriggerFileCompletion.bind(current) } : {}),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      const query = MENTION_QUERY.exec((lines[cursorLine] ?? "").slice(0, cursorCol))?.[1];
      if (query === undefined) return base;
      const all = await candidates(), items = mentionItems(all, multiRepo());
      const matched = items.filter((_, i) => !query || all[i]!.title.includes(query) || all[i]!.requirementId.endsWith(query) ||
        items[i]!.label.includes(`#${query}`));
      if (!matched.length) return base;
      const prefix = `@${query}`;
      return { items: [...matched, ...(base?.prefix === prefix ? base.items : [])], prefix };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!item.value.startsWith("@[")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      const line = lines[cursorLine] ?? "", start = cursorCol - prefix.length;
      const next = [...lines];
      next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
      return { lines: next, cursorLine, cursorCol: start + item.value.length };
    },
  };
}
