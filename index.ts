import type { Plugin } from '@opencode-ai/plugin';
import { splitIntoCommands, parseReminders } from './src/parser';
import { readAgentSequence } from './src/sequence';
import { createNextTaskTool } from './src/next-task-tool';

export const BoundariesPlugin: Plugin = async ({ client }, options = {}) => {
  let reminders = parseReminders(options);

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

    'session.created': async ({ session }) => {
      // Read the sequence for this agent if it exists
      const sequence = await readAgentSequence(session.agent, session.root);

      if (!sequence || sequence.length === 0) {
        return;
      }

      // Inject the first task as context (no LLM reply)
      const firstTask = sequence[0];
      const contextMessage = `You are operating in sequence mode. You will be given tasks one at a time.
Complete each task fully before calling \`next_task\` to receive the next one.
Do not attempt to work ahead or skip steps.

You have ${sequence.length} task(s) to complete.`;

      const taskMessage = `## Task 1: ${firstTask.name}\n\n${firstTask.prompt}`;

      try {
        await client.session.prompt({
          path: { id: session.id },
          body: {
            noReply: true,
            parts: [
              { type: 'text', text: contextMessage },
              { type: 'text', text: taskMessage },
            ],
          },
        });
      } catch (err) {
        // Log but don't fail if injection doesn't work
        await client.app.log({
          body: {
            service: 'opencode-plugin-boundaries',
            level: 'warn',
            message: 'Failed to inject initial sequence prompt',
            extra: { error: err instanceof Error ? err.message : String(err) },
          },
        });
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
      next_task: createNextTaskTool(client),
    },
  };
};
