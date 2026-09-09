export type FakeEventHandler = (event: unknown, ctx: unknown) => unknown;

export interface FakePiApi {
  on(event: string, handler: FakeEventHandler): void;
}

export interface FakePi {
  pi: FakePiApi;
  trigger(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
  handlerCount(event: string): number;
}

export function createFakePi(): FakePi {
  const handlers = new Map<string, FakeEventHandler[]>();
  return {
    pi: {
      on(event: string, handler: FakeEventHandler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    },
    async trigger(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
      const list = handlers.get(event) ?? [];
      const results: unknown[] = [];
      for (const handler of list) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
    handlerCount(event: string): number {
      return (handlers.get(event) ?? []).length;
    },
  };
}
