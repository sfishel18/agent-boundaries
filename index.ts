import type { Plugin, PluginOptions } from '@opencode-ai/plugin';
import bashParser from 'bash-parser';

// ─── bash-parser AST types ────────────────────────────────────────────────────

type CommandExpansion = { type: 'CommandExpansion'; commandAST: ASTNode };
type ParameterExpansion = { type: 'ParameterExpansion'; word?: Word };
type ArithmeticExpansion = { type: 'ArithmeticExpansion' };
type Expansion = CommandExpansion | ParameterExpansion | ArithmeticExpansion;

type Word = { type: 'Word'; text: string; expansion?: Expansion[] };
type Name = { type: 'Name'; text: string };
type AssignmentWord = { type: 'AssignmentWord'; text: string };
type CompoundList = { type: 'CompoundList'; commands: ASTNode[] };

type Script = { type: 'Script'; commands: ASTNode[] };
type Command = {
  type: 'Command';
  name?: Word;
  prefix?: AssignmentWord[];
  suffix?: Word[];
};
type LogicalExpression = {
  type: 'LogicalExpression';
  op: 'and' | 'or';
  left: ASTNode;
  right: ASTNode;
};
type Pipeline = { type: 'Pipeline'; commands: ASTNode[] };
type Subshell = { type: 'Subshell'; list: CompoundList };
type For = { type: 'For'; name: Name; do: CompoundList };
type While = { type: 'While'; clause: CompoundList; do: CompoundList };
type Until = { type: 'Until'; clause: CompoundList; do: CompoundList };
type If = {
  type: 'If';
  clause: CompoundList;
  then: CompoundList;
  else?: CompoundList;
};
type BashFunction = {
  type: 'Function';
  body: { type: 'CompoundList'; commands: ASTNode[] };
};

type ASTNode =
  | Script
  | Command
  | LogicalExpression
  | Pipeline
  | Subshell
  | For
  | While
  | Until
  | If
  | BashFunction
  | CompoundList;

// ─── Command extraction ───────────────────────────────────────────────────────

/**
 * Extracts commands from all expansions within a Word (e.g. command
 * substitutions `$(...)`, parameter expansions `${VAR:-$(cmd)}`).
 * Only descends one level into sub-command ASTs; the `depth` parameter
 * tracks how many expansion boundaries have already been crossed.
 */
function extractFromExpansions(word: Word, depth: number, maxDepth: number): string[] {
  if (!word.expansion || depth >= maxDepth) return [];
  const results: string[] = [];
  for (const exp of word.expansion) {
    if (exp.type === 'CommandExpansion') {
      results.push(...extractCommands(exp.commandAST, depth + 1, maxDepth));
    } else if (exp.type === 'ParameterExpansion' && exp.word) {
      results.push(...extractFromExpansions(exp.word, depth, maxDepth));
    }
    // ArithmeticExpansion contains no bash commands — skip
  }
  return results;
}

/**
 * Recursively walks a bash AST and collects every leaf `Command` as a
 * reconstructed command string (e.g. `"npx foo --bar"`).
 */
export function extractCommands(node: ASTNode, depth = 0, maxDepth = Infinity): string[] {
  switch (node.type) {
    case 'Script':
      return node.commands.flatMap((n) => extractCommands(n, depth, maxDepth));

    case 'LogicalExpression':
      return [
        ...extractCommands(node.left, depth, maxDepth),
        ...extractCommands(node.right, depth, maxDepth),
      ];

    case 'Pipeline':
      return node.commands.flatMap((n) => extractCommands(n, depth, maxDepth));

    case 'Subshell':
      return node.list.commands.flatMap((n) => extractCommands(n, depth, maxDepth));

    case 'For':
      return node.do.commands.flatMap((n) => extractCommands(n, depth, maxDepth));

    case 'While':
    case 'Until':
      return [
        ...node.clause.commands.flatMap((n) => extractCommands(n, depth, maxDepth)),
        ...node.do.commands.flatMap((n) => extractCommands(n, depth, maxDepth)),
      ];

    case 'If': {
      const parts = [
        ...node.clause.commands.flatMap((n) => extractCommands(n, depth, maxDepth)),
        ...node.then.commands.flatMap((n) => extractCommands(n, depth, maxDepth)),
      ];
      if (node.else)
        parts.push(...node.else.commands.flatMap((n) => extractCommands(n, depth, maxDepth)));
      return parts;
    }

    case 'Function':
      return node.body.commands.flatMap((n) => extractCommands(n, depth, maxDepth));

    case 'CompoundList':
      return node.commands.flatMap((n) => extractCommands(n, depth, maxDepth));

    case 'Command': {
      if (!node.name) return []; // bare assignment: FOO=bar
      const parts = [node.name.text, ...(node.suffix?.map((w) => w.text) ?? [])];
      const outer = parts.join(' ');
      // Collect commands from any expansions in suffix words (inner after outer)
      const inner = (node.suffix ?? []).flatMap((w) =>
        extractFromExpansions(w, depth, maxDepth),
      );
      return [outer, ...inner];
    }
  }
}

/**
 * Parses a bash command string and returns every primitive command invocation
 * within it. Falls back to `[command]` if the parser throws (e.g. for
 * bash-specific syntax the POSIX parser doesn't understand).
 */
export function splitIntoCommands(command: string): string[] {
  const MAX_EXPANSION_DEPTH = 1;
  try {
    const ast = bashParser(command) as ASTNode;
    const commands = extractCommands(ast, 0, MAX_EXPANSION_DEPTH);
    return commands.length > 0 ? commands : [command];
  } catch {
    return [command];
  }
}

// ─── Nudge parsing ────────────────────────────────────────────────────────────

/**
 * Parses nudge rules from plugin options.
 *
 * Keys are of the form `nudge(<pattern>)` where `*` matches any characters.
 * Values are the suggestion message to show the LLM.
 *
 * Example:
 *   { "nudge(npx *)": "use `npm run` instead" }
 */
export function parseNudges(
  options: PluginOptions,
): Array<{ pattern: RegExp; message: string }> {
  const nudges: Array<{ pattern: RegExp; message: string }> = [];

  for (const [key, value] of Object.entries(options)) {
    const match = key.match(/^nudge\((.+)\)$/);
    if (!match || typeof value !== 'string') continue;

    const glob = match[1]!;
    // Escape regex special chars, then replace `*` with `.*`
    const escaped = glob
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    nudges.push({ pattern: new RegExp(`^${escaped}`), message: value });
  }

  return nudges;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

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
      if (input.tool !== 'bash' || nudges.length === 0) return;

      const command: string = output.args.command ?? '';
      const description: string = output.args.description ?? '';

      // Allow the LLM to bypass a nudge by prefixing the description with "OVERRIDE:"
      if (description.trimStart().startsWith('OVERRIDE:')) return;

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
