export type HookName =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "PreCompact";
export type HookHandler = (data: Record<string, unknown>) => void | Promise<void>;
export class Hooks {
  private handlers = new Map<HookName, HookHandler[]>();
  on(name: HookName, handler: HookHandler): () => void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }
  async emit(name: HookName, data: Record<string, unknown> = {}): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(data);
  }
}
