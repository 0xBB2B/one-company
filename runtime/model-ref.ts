interface ModelIdentity { provider: string; id: string }

/**
 * 按定义里的 model 找本机模型。写"提供方/模型名"即指定；只写模型名时，preferredProvider 有这个模型就用它，
 * 否则要求本机恰好一个提供方有同名模型，多个时不替用户挑。
 */
export function findDefinedModel<M extends ModelIdentity>(ref: string, models: readonly M[], preferredProvider: string | undefined): { ok: true; model: M } | { ok: false; reason: string } {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const model = models.find((entry) => entry.provider === ref.slice(0, slash) && entry.id === ref.slice(slash + 1));
    return model ? { ok: true, model } : { ok: false, reason: `本机的模型配置里找不到模型 ${ref}` };
  }
  const named = models.filter((entry) => entry.id === ref);
  const preferred = named.find((entry) => entry.provider === preferredProvider);
  if (preferred) return { ok: true, model: preferred };
  if (named.length === 1) return { ok: true, model: named[0]! };
  if (named.length === 0) return { ok: false, reason: `本机的模型配置里找不到模型 ${ref}` };
  return { ok: false, reason: `本机有多个提供方都有模型 ${ref}（${named.map((entry) => `${entry.provider}/${entry.id}`).join("、")}），请把 model 改写成 提供方/模型名` };
}
