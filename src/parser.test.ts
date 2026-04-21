import { describe, it, expect } from 'vitest';
import { parseNudges, splitIntoCommands, extractCommands } from './parser.ts';

// ─── parseNudges ──────────────────────────────────────────────────────────────

describe('parseNudges', () => {
  it('returns an empty array for empty options', () => {
    expect(parseNudges({})).toEqual([]);
  });

  it('ignores keys that are not nudge(...) patterns', () => {
    expect(parseNudges({ foo: 'bar', 'nudge-bad': 'x' })).toEqual([]);
  });

  it('ignores nudge keys whose value is not a string', () => {
    expect(parseNudges({ 'nudge(npx *)': 42 as unknown as string })).toEqual(
      [],
    );
  });

  it('parses a single nudge rule', () => {
    const nudges = parseNudges({ 'nudge(npx *)': 'use npm run instead' });
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.message).toBe('use npm run instead');
  });

  it('converts a glob pattern with * to a working RegExp', () => {
    const [nudge] = parseNudges({ 'nudge(npx *)': 'msg' });
    expect(nudge!.pattern.test('npx eslint .')).toBe(true);
    expect(nudge!.pattern.test('npx foo --bar')).toBe(true);
    expect(nudge!.pattern.test('npm run lint')).toBe(false);
  });

  it('escapes regex special characters in the glob pattern', () => {
    // The dot in "node_modules/.bin/foo" must be a literal dot, not a wildcard
    const [nudge] = parseNudges({ 'nudge(node_modules/.bin/*)': 'msg' });
    expect(nudge!.pattern.test('node_modules/.bin/eslint')).toBe(true);
    // A pattern with any char in place of the dot should NOT match
    expect(nudge!.pattern.test('node_modulesXbinYfoo')).toBe(false);
  });

  it('parses multiple nudge rules', () => {
    const nudges = parseNudges({
      'nudge(npx *)': 'use npm run',
      'nudge(git push --force *)': 'discuss first',
    });
    expect(nudges).toHaveLength(2);
    expect(nudges.map((n) => n.message)).toEqual([
      'use npm run',
      'discuss first',
    ]);
  });

  it('patterns are anchored at the start — does not match a mid-string occurrence', () => {
    const [nudge] = parseNudges({ 'nudge(npx *)': 'use npm run' });
    expect(nudge!.pattern.test('npx eslint .')).toBe(true);
    expect(nudge!.pattern.test('echo npx eslint .')).toBe(false);
  });

  it('patterns are not anchored at the end — a prefix pattern still matches', () => {
    // "rm -rf /" should match "rm -rf /tmp" because end is unanchored
    const [nudge] = parseNudges({ 'nudge(rm -rf /)': 'absolutely not' });
    expect(nudge!.pattern.test('rm -rf /')).toBe(true);
    expect(nudge!.pattern.test('rm -rf /tmp')).toBe(true);
  });
});

// ─── splitIntoCommands ────────────────────────────────────────────────────────

describe('splitIntoCommands', () => {
  it('returns a single command unchanged', () => {
    expect(splitIntoCommands('echo hello')).toEqual(['echo hello']);
  });

  it('splits && (logical AND) into individual commands', () => {
    expect(splitIntoCommands('npm install && npm test')).toEqual([
      'npm install',
      'npm test',
    ]);
  });

  it('splits || (logical OR) into individual commands', () => {
    expect(splitIntoCommands('npm test || echo failed')).toEqual([
      'npm test',
      'echo failed',
    ]);
  });

  it('splits a pipeline into individual commands', () => {
    expect(splitIntoCommands('cat file.txt | grep foo')).toEqual([
      'cat file.txt',
      'grep foo',
    ]);
  });

  it('splits commands inside a subshell', () => {
    expect(splitIntoCommands('(cd /tmp && ls)')).toEqual(['cd /tmp', 'ls']);
  });

  it('extracts commands from a chained logical + pipeline expression', () => {
    const result = splitIntoCommands(
      'npx eslint . && git push --force origin main',
    );
    expect(result).toEqual(['npx eslint .', 'git push --force origin main']);
  });

  it('extracts commands from sub-commands', () => {
    const result = splitIntoCommands('echo $(git rev-parse HEAD)');
    expect(result).toEqual([
      'echo $(git rev-parse HEAD)',
      'git rev-parse HEAD',
    ]);
  });

  it('falls back to [command] when the parser throws on unsupported syntax', () => {
    // Bash-specific syntax that the POSIX parser cannot handle
    const bashSpecific = 'echo $((1 + 2))';
    const result = splitIntoCommands(bashSpecific);
    // Either parsed successfully (one element) or fell back to the original
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result).toContain(bashSpecific);
  });

  it('handles bare variable assignments by ignoring them', () => {
    // A bare assignment produces no Command with a name, so extractCommands
    // returns [] and splitIntoCommands falls back to [command]
    const result = splitIntoCommands('FOO=bar');
    expect(result).toEqual(['FOO=bar']);
  });

  it('ignores bare variable assignments that precede commands', () => {
    // A bare assignment produces no Command with a name, so extractCommands
    // returns [] and splitIntoCommands falls back to [command]
    const result = splitIntoCommands('FOO=bar npx eslint .');
    expect(result).toEqual(['npx eslint .']);
  });
});

// ─── extractCommands ──────────────────────────────────────────────────────────

describe('extractCommands', () => {
  it('extracts a simple Command node', () => {
    expect(
      extractCommands({
        type: 'Command',
        name: { type: 'Word', text: 'echo' },
        suffix: [{ type: 'Word', text: 'hello' }],
      }),
    ).toEqual(['echo hello']);
  });

  it('returns [] for a bare-assignment Command (no name)', () => {
    expect(
      extractCommands({
        type: 'Command',
        prefix: [{ type: 'AssignmentWord', text: 'FOO=bar' }],
      }),
    ).toEqual([]);
  });

  it('reconstructs a command with multiple suffix words', () => {
    expect(
      extractCommands({
        type: 'Command',
        name: { type: 'Word', text: 'git' },
        suffix: [
          { type: 'Word', text: 'push' },
          { type: 'Word', text: '--force' },
          { type: 'Word', text: 'origin' },
          { type: 'Word', text: 'main' },
        ],
      }),
    ).toEqual(['git push --force origin main']);
  });

  it('flattens commands from a Script node', () => {
    expect(
      extractCommands({
        type: 'Script',
        commands: [
          { type: 'Command', name: { type: 'Word', text: 'echo' } },
          { type: 'Command', name: { type: 'Word', text: 'ls' } },
        ],
      }),
    ).toEqual(['echo', 'ls']);
  });

  it('flattens commands from a LogicalExpression node', () => {
    expect(
      extractCommands({
        type: 'LogicalExpression',
        op: 'and',
        left: {
          type: 'Command',
          name: { type: 'Word', text: 'npm' },
          suffix: [{ type: 'Word', text: 'install' }],
        },
        right: {
          type: 'Command',
          name: { type: 'Word', text: 'npm' },
          suffix: [{ type: 'Word', text: 'test' }],
        },
      }),
    ).toEqual(['npm install', 'npm test']);
  });

  it('flattens commands from a Pipeline node', () => {
    expect(
      extractCommands({
        type: 'Pipeline',
        commands: [
          {
            type: 'Command',
            name: { type: 'Word', text: 'cat' },
            suffix: [{ type: 'Word', text: 'file.txt' }],
          },
          {
            type: 'Command',
            name: { type: 'Word', text: 'grep' },
            suffix: [{ type: 'Word', text: 'foo' }],
          },
        ],
      }),
    ).toEqual(['cat file.txt', 'grep foo']);
  });

  it('flattens commands from a Subshell node', () => {
    expect(
      extractCommands({
        type: 'Subshell',
        list: {
          type: 'CompoundList',
          commands: [{ type: 'Command', name: { type: 'Word', text: 'ls' } }],
        },
      }),
    ).toEqual(['ls']);
  });

  it('flattens commands from a For node (do body only)', () => {
    expect(
      extractCommands({
        type: 'For',
        name: { type: 'Name', text: 'f' },
        do: {
          type: 'CompoundList',
          commands: [
            {
              type: 'Command',
              name: { type: 'Word', text: 'echo' },
              suffix: [{ type: 'Word', text: '$f' }],
            },
          ],
        },
      }),
    ).toEqual(['echo $f']);
  });

  it('flattens clause + do from a While node', () => {
    const result = extractCommands({
      type: 'While',
      clause: {
        type: 'CompoundList',
        commands: [{ type: 'Command', name: { type: 'Word', text: 'true' } }],
      },
      do: {
        type: 'CompoundList',
        commands: [
          {
            type: 'Command',
            name: { type: 'Word', text: 'echo' },
            suffix: [{ type: 'Word', text: 'loop' }],
          },
        ],
      },
    });
    expect(result).toEqual(['true', 'echo loop']);
  });

  it('flattens clause + do from an Until node', () => {
    const result = extractCommands({
      type: 'Until',
      clause: {
        type: 'CompoundList',
        commands: [{ type: 'Command', name: { type: 'Word', text: 'false' } }],
      },
      do: {
        type: 'CompoundList',
        commands: [
          {
            type: 'Command',
            name: { type: 'Word', text: 'echo' },
            suffix: [{ type: 'Word', text: 'done' }],
          },
        ],
      },
    });
    expect(result).toEqual(['false', 'echo done']);
  });

  it('flattens clause + then from an If node (no else)', () => {
    const result = extractCommands({
      type: 'If',
      clause: {
        type: 'CompoundList',
        commands: [
          {
            type: 'Command',
            name: { type: 'Word', text: 'test' },
            suffix: [
              { type: 'Word', text: '-f' },
              { type: 'Word', text: 'foo' },
            ],
          },
        ],
      },
      then: {
        type: 'CompoundList',
        commands: [
          {
            type: 'Command',
            name: { type: 'Word', text: 'echo' },
            suffix: [{ type: 'Word', text: 'yes' }],
          },
        ],
      },
    });
    expect(result).toEqual(['test -f foo', 'echo yes']);
  });

  it('includes the else branch of an If node when present', () => {
    const result = extractCommands({
      type: 'If',
      clause: {
        type: 'CompoundList',
        commands: [{ type: 'Command', name: { type: 'Word', text: 'test' } }],
      },
      then: {
        type: 'CompoundList',
        commands: [
          {
            type: 'Command',
            name: { type: 'Word', text: 'echo' },
            suffix: [{ type: 'Word', text: 'yes' }],
          },
        ],
      },
      else: {
        type: 'CompoundList',
        commands: [
          {
            type: 'Command',
            name: { type: 'Word', text: 'echo' },
            suffix: [{ type: 'Word', text: 'no' }],
          },
        ],
      },
    });
    expect(result).toEqual(['test', 'echo yes', 'echo no']);
  });

  it('flattens commands from a Function body', () => {
    expect(
      extractCommands({
        type: 'Function',
        body: {
          type: 'CompoundList',
          commands: [
            {
              type: 'Command',
              name: { type: 'Word', text: 'echo' },
              suffix: [{ type: 'Word', text: 'fn' }],
            },
          ],
        },
      }),
    ).toEqual(['echo fn']);
  });

  it('flattens commands from a CompoundList node', () => {
    expect(
      extractCommands({
        type: 'CompoundList',
        commands: [
          { type: 'Command', name: { type: 'Word', text: 'a' } },
          { type: 'Command', name: { type: 'Word', text: 'b' } },
        ],
      }),
    ).toEqual(['a', 'b']);
  });
});
