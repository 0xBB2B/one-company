/** Node 22 的内置 SQLite 声明警告不是运行失败；其余 stderr 原样保留。 */
export function withoutSqliteExperimentalWarning(stderr: string): string {
  return stderr.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/gm, "");
}
