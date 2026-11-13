export function leanToolResult<T>(full: T, view: unknown): { content: { type: "text"; text: string }[]; details: T | null } {
  const text = typeof view === "string" ? view : JSON.stringify(view ?? null);
  return { content: [{ type: "text", text }], details: full ?? null };
}
