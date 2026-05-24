import { describe, it, expect } from 'vitest';
import { readAgentSequence } from './sequence';
import type { Config } from '@opencode-ai/plugin';

describe('readAgentSequence', () => {
  it('returns null when config is undefined', async () => {
    const result = await readAgentSequence('test-agent', undefined);
    expect(result).toBeNull();
  });

  it('returns null when agent is not in config', async () => {
    const config: Config = {
      agent: {},
    };
    const result = await readAgentSequence('nonexistent', config);
    expect(result).toBeNull();
  });

  it('returns null when agent has no sequence defined', async () => {
    const config: Config = {
      agent: {
        'test-agent': {},
      },
    };
    const result = await readAgentSequence('test-agent', config);
    expect(result).toBeNull();
  });

  it('parses a valid sequence with single task', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              name: 'task-one',
              prompt: 'Do something',
            },
          ],
        },
      },
    };
    const result = await readAgentSequence('test-agent', config);
    expect(result).toEqual([
      {
        name: 'task-one',
        prompt: 'Do something',
      },
    ]);
  });

  it('parses a sequence with multiple tasks', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              name: 'task-one',
              prompt: 'First task',
            },
            {
              name: 'task-two',
              prompt: 'Second task',
            },
            {
              name: 'task-three',
              prompt: 'Third task',
            },
          ],
        },
      },
    };
    const result = await readAgentSequence('test-agent', config);
    expect(result).toHaveLength(3);
    expect(result?.[0]?.name).toBe('task-one');
    expect(result?.[1]?.name).toBe('task-two');
    expect(result?.[2]?.name).toBe('task-three');
  });

  it('parses tasks with validation rules', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              name: 'task-with-validation',
              prompt: 'Do something',
              validate: [
                {
                  type: 'bash',
                  command: 'npm test',
                },
              ],
            },
          ],
        },
      },
    };
    const result = await readAgentSequence('test-agent', config);
    expect(result?.[0]?.validate).toHaveLength(1);
    expect(result?.[0]?.validate?.[0]?.type).toBe('bash');
  });

  it('rejects sequence with missing required name field', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              // @ts-expect-error - intentionally missing 'name'
              prompt: 'Missing name',
            },
          ],
        },
      },
    };
    await expect(readAgentSequence('test-agent', config)).rejects.toThrow();
  });

  it('rejects sequence with missing required prompt field', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              // @ts-expect-error - intentionally missing 'prompt'
              name: 'Missing prompt',
            },
          ],
        },
      },
    };
    await expect(readAgentSequence('test-agent', config)).rejects.toThrow();
  });

  it('rejects sequence with invalid validation rule type', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              name: 'task',
              prompt: 'Do something',
              validate: [
                {
                  // @ts-expect-error - intentionally invalid type
                  type: 'invalid_type',
                },
              ],
            },
          ],
        },
      },
    };
    await expect(readAgentSequence('test-agent', config)).rejects.toThrow();
  });

  it('allows additional properties on validation rules (passthrough)', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              name: 'task',
              prompt: 'Do something',
              validate: [
                {
                  type: 'llm_judge',
                  prompt: 'Is it correct?',
                  customField: 'custom-value',
                },
              ],
            },
          ],
        },
      },
    };
    const result = await readAgentSequence('test-agent', config);
    expect(result?.[0]?.validate?.[0]).toEqual({
      type: 'llm_judge',
      prompt: 'Is it correct?',
      customField: 'custom-value',
    });
  });

  it('parses mixed tasks with and without validation', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              name: 'task-one',
              prompt: 'No validation',
            },
            {
              name: 'task-two',
              prompt: 'With validation',
              validate: [
                {
                  type: 'bash',
                  command: 'echo ok',
                },
              ],
            },
            {
              name: 'task-three',
              prompt: 'No validation',
            },
          ],
        },
      },
    };
    const result = await readAgentSequence('test-agent', config);
    expect(result).toHaveLength(3);
    expect(result?.[0]?.validate).toBeUndefined();
    expect(result?.[1]?.validate).toHaveLength(1);
    expect(result?.[2]?.validate).toBeUndefined();
  });

  it('handles multiple validation rules on a single task', async () => {
    const config: Config = {
      agent: {
        'test-agent': {
          sequence: [
            {
              name: 'task',
              prompt: 'Do something',
              validate: [
                {
                  type: 'bash',
                  command: 'npm test',
                },
                {
                  type: 'tool_call',
                  tool: 'bash',
                  count: 2,
                },
                {
                  type: 'llm_judge',
                  prompt: 'Is it done?',
                },
              ],
            },
          ],
        },
      },
    };
    const result = await readAgentSequence('test-agent', config);
    expect(result?.[0]?.validate).toHaveLength(3);
    expect(result?.[0]?.validate?.map((v) => v.type)).toEqual([
      'bash',
      'tool_call',
      'llm_judge',
    ]);
  });
});
