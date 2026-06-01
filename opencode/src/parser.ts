import type { PluginOptions } from '@opencode-ai/plugin';
export { splitIntoCommands, extractCommands } from '../../shared/parser';

export function parseReminders(
  options: PluginOptions,
): Array<{ pattern: RegExp; message: string }> {
  const reminders: Array<{ pattern: RegExp; message: string }> = [];

  for (const [key, value] of Object.entries(options)) {
    const match = key.match(/^reminder\((.+)\)$/);
    if (!match || typeof value !== 'string') continue;

    const pattern = match[1]!;

    try {
      const regex = new RegExp(`^(${pattern})`);
      reminders.push({ pattern: regex, message: value });
    } catch {
      continue;
    }
  }

  return reminders;
}
