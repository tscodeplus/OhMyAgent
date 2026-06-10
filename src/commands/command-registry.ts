import type { CommandContext, CommandResult, CommandHandler } from '../extensions/types.js';

export class CommandRegistry {
  private handlers = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void {
    if (this.handlers.has(name)) {
      // Overwrite silently (last registration wins)
    }
    this.handlers.set(name, handler);
  }

  unregister(name: string): void {
    this.handlers.delete(name);
  }

  list(): string[] {
    return Array.from(this.handlers.keys());
  }

  async handle(text: string, ctx: CommandContext): Promise<CommandResult | null> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const handler = this.handlers.get(command);
    if (!handler) return null;

    return handler({ ...ctx, args });
  }
}
