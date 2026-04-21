import type { PluginOptions } from '@opencode-ai/plugin';
import bashParser from 'bash-parser';

export type CommandExpansion = { type: 'CommandExpansion'; commandAST: ASTNode };
export type ParameterExpansion = { type: 'ParameterExpansion'; word?: Word };
export type ArithmeticExpansion = { type: 'ArithmeticExpansion' };
export type Expansion = CommandExpansion | ParameterExpansion | ArithmeticExpansion;

export type Word = { type: 'Word'; text: string; expansion?: Expansion[] };
export type Name = { type: 'Name'; text: string };
export type AssignmentWord = { type: 'AssignmentWord'; text: string };
export type CompoundList = { type: 'CompoundList'; commands: ASTNode[] };

export type Script = { type: 'Script'; commands: ASTNode[] };
export type Command = {
  type: 'Command';
  name?: Word;
  prefix?: AssignmentWord[];
  suffix?: Word[];
};
export type LogicalExpression = {
  type: 'LogicalExpression';
  op: 'and' | 'or';
  left: ASTNode;
  right: ASTNode;
};
export type Pipeline = { type: 'Pipeline'; commands: ASTNode[] };
export type Subshell = { type: 'Subshell'; list: CompoundList };
export type For = { type: 'For'; name: Name; do: CompoundList };
export type While = { type: 'While'; clause: CompoundList; do: CompoundList };
export type Until = { type: 'Until'; clause: CompoundList; do: CompoundList };
export type If = {
  type: 'If';
  clause: CompoundList;
  then: CompoundList;
  else?: CompoundList;
};
export type BashFunction = {
  type: 'Function';
  body: { type: 'CompoundList'; commands: ASTNode[] };
};

export type ASTNode =
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

export function extractFromExpansions(
  word: Word,
  depth: number,
  maxDepth: number,
): string[] {
  if (!word.expansion || depth >= maxDepth) return [];
  const results: string[] = [];
  for (const exp of word.expansion) {
    if (exp.type === 'CommandExpansion') {
      results.push(...extractCommands(exp.commandAST, depth + 1, maxDepth));
    } else if (exp.type === 'ParameterExpansion' && exp.word) {
      results.push(...extractFromExpansions(exp.word, depth, maxDepth));
    }
  }
  return results;
}

export function extractCommands(
  node: ASTNode,
  depth = 0,
  maxDepth = Infinity,
): string[] {
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
      return node.list.commands.flatMap((n) =>
        extractCommands(n, depth, maxDepth),
      );

    case 'For':
      return node.do.commands.flatMap((n) =>
        extractCommands(n, depth, maxDepth),
      );

    case 'While':
    case 'Until':
      return [
        ...node.clause.commands.flatMap((n) =>
          extractCommands(n, depth, maxDepth),
        ),
        ...node.do.commands.flatMap((n) => extractCommands(n, depth, maxDepth)),
      ];

    case 'If': {
      const parts = [
        ...node.clause.commands.flatMap((n) =>
          extractCommands(n, depth, maxDepth),
        ),
        ...node.then.commands.flatMap((n) =>
          extractCommands(n, depth, maxDepth),
        ),
      ];
      if (node.else)
        parts.push(
          ...node.else.commands.flatMap((n) =>
            extractCommands(n, depth, maxDepth),
          ),
        );
      return parts;
    }

    case 'Function':
      return node.body.commands.flatMap((n) =>
        extractCommands(n, depth, maxDepth),
      );

    case 'CompoundList':
      return node.commands.flatMap((n) => extractCommands(n, depth, maxDepth));

    case 'Command': {
      if (!node.name) return [];
      const parts = [
        node.name.text,
        ...(node.suffix?.map((w) => w.text) ?? []),
      ];
      const outer = parts.join(' ');
      const inner = (node.suffix ?? []).flatMap((w) =>
        extractFromExpansions(w, depth, maxDepth),
      );
      return [outer, ...inner];
    }
  }
}

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

export function parseNudges(
  options: PluginOptions,
): Array<{ pattern: RegExp; message: string }> {
  const nudges: Array<{ pattern: RegExp; message: string }> = [];

  for (const [key, value] of Object.entries(options)) {
    const match = key.match(/^nudge\((.+)\)$/);
    if (!match || typeof value !== 'string') continue;

    const glob = match[1]!;
    const escaped = glob
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    nudges.push({ pattern: new RegExp(`^${escaped}`), message: value });
  }

  return nudges;
}