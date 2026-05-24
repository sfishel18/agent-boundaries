import type { Config, Plugin } from '@opencode-ai/plugin';
import { splitIntoCommands, parseReminders } from './src/parser';
import { createNextTaskTool } from './src/next-task-tool';

export const BoundariesPlugin: Plugin = async ({ client }, options = {}) => {
  let reminders = parseReminders(options);
  const configRef = { current: undefined as Config | undefined };

  await client.app.log({
    body: {
      service: 'opencode-plugin-boundaries',
      level: 'info',
      message: 'Plugin initialized',
      extra: { reminderCount: reminders.length },
    },
  });

  return {
    config: async (config) => {
      configRef.current = config;
      if (reminders.length > 0) {
        return;
      }
      const pluginConfig = config.plugin?.find(
        (p) =>
          typeof p[0] === 'string' &&
          (p[0] === 'opencode-plugin-boundaries' ||
            p[0].endsWith('/opencode-plugin-boundaries')),
      )?.[1];
      if (pluginConfig && typeof pluginConfig === 'object') {
        reminders = parseReminders(pluginConfig);
      }
    },

    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'bash' || reminders.length === 0) {
        return;
      }
      const command: string = output.args.command ?? '';
      const description: string = output.args.description ?? '';
      if (description.trimStart().startsWith('OVERRIDE:')) {
        return;
      }
      const primitives = splitIntoCommands(command);
      for (const primitive of primitives) {
        for (const reminder of reminders) {
          if (reminder.pattern.test(primitive)) {
            throw new Error(
              `Reminder: ${reminder.message}\n\n` +
                `If you want to run this command anyway, set the tool call description to start with "OVERRIDE:" to bypass this check.`,
            );
          }
        }
      }
    },

    tool: {
      next_task: createNextTaskTool(client, configRef),
    },
  };
};
