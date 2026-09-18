export type FakeEventHandler = (event: unknown, ctx: unknown) => unknown;
export type FakeCommandHandler = (args: string, ctx: unknown) => unknown;

export interface FakeRegisteredCommand {
  name: string;
  description: string;
  handler: FakeCommandHandler;
}

export interface FakePiApi {
  on(event: string, handler: FakeEventHandler): void;
  registerTool(tool: { name: string }): void;
  registerCommand(name: string, options: { description: string; handler: FakeCommandHandler }): void;
  registerMessageRenderer(type: string, renderer: unknown): void;
  registerFlag(name: string, options: unknown): void;
}

export interface FakePi {
  pi: FakePiApi;
  trigger(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
  handlerCount(event: string): number;
  handlersFor(event: string): FakeEventHandler[];
  registeredTools(): { name: string }[];
  registeredCommands(): FakeRegisteredCommand[];
}

export function createFakePi(): FakePi {
  const handlers = new Map<string, FakeEventHandler[]>();
  const tools: { name: string }[] = [];
  const commands: FakeRegisteredCommand[] = [];
  return {
    pi: {
      on(event: string, handler: FakeEventHandler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      registerCommand(name: string, options: { description: string; handler: FakeCommandHandler }) {
        commands.push({ name, description: options.description, handler: options.handler });
      },
      registerMessageRenderer() {},
      registerFlag() {},
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
    handlersFor(event: string): FakeEventHandler[] {
      return (handlers.get(event) ?? []).slice();
    },
    registeredTools(): { name: string }[] {
      return tools.slice();
    },
    registeredCommands(): FakeRegisteredCommand[] {
      return commands.slice();
    },
  };
}
