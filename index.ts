import type { Plugin } from '@opencode-ai/plugin';
import { splitIntoCommands, parseNudges } from './src/parser';

export const BoundariesPlugin: Plugin = async ({ client }, options = {}) => {
  let nudges = parseNudges(options);

  await client.app.log({
    body: {
      service: 'opencode-plugin-boundaries',
      level: 'info',
      message: 'Plugin initialized',
      extra: { nudgeCount: nudges.length },
    },
  });

  return {
    config: async (config) => {
      if (nudges.length > 0) {
        return;
      }
      const pluginConfig = config.plugin?.find(
        (p) =>
          typeof p[0] === 'string' &&
          (p[0] === 'opencode-plugin-boundaries' ||
            p[0].endsWith('/opencode-plugin-boundaries')),
      )?.[1];
      if (pluginConfig && typeof pluginConfig === 'object') {
        nudges = parseNudges(pluginConfig);
      }
    },

    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'bash' || nudges.length === 0) {
        return;
      }
      const command: string = output.args.command ?? '';
      const description: string = output.args.description ?? '';
      if (description.trimStart().startsWith('OVERRIDE:')) {
        return;
      }
      const primitives = splitIntoCommands(command);
      for (const primitive of primitives) {
        for (const nudge of nudges) {
          if (nudge.pattern.test(primitive)) {
            throw new Error(
              `Nudge: ${nudge.message}\n\n` +
                `If you want to run this command anyway, set the tool call description to start with "OVERRIDE:" to bypass this check.`,
            );
          }
        }
      }
    },
  };
};
