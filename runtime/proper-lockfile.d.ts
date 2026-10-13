declare module "proper-lockfile" {
  export function lockSync(file: string, options?: { realpath?: boolean }): () => void;
}
