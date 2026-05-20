import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from './sequence';

describe('parseFrontmatter - sequence parsing', () => {
  it('parses basic sequence with name and prompt', () => {
    const content = `---
description: Test agent
sequence:
  - name: task-one
    prompt: Do task one
---`;

    const result = parseFrontmatter(content);
    expect(result?.sequence).toBeDefined();
    expect(result?.sequence).toHaveLength(1);
    expect(result?.sequence?.[0]).toEqual({
      name: 'task-one',
      prompt: 'Do task one',
      validate: [],
    });
  });

  it('parses multiple tasks in sequence', () => {
    const content = `---
description: Test agent
sequence:
  - name: planning
    prompt: Plan the solution
  - name: implementation
    prompt: Implement it
  - name: testing
    prompt: Test it
---`;

    const result = parseFrontmatter(content);
    expect(result?.sequence).toHaveLength(3);
    expect(result?.sequence?.[0]?.name).toBe('planning');
    expect(result?.sequence?.[1]?.name).toBe('implementation');
    expect(result?.sequence?.[2]?.name).toBe('testing');
  });

  it('parses validation rules (llm_judge)', () => {
    const content = `---
description: Test agent
sequence:
  - name: task-one
    prompt: Do something
    validate:
      - type: llm_judge
        prompt: Is it correct?
---`;

    const result = parseFrontmatter(content);
    const task = result?.sequence?.[0];
    expect(task?.validate).toHaveLength(1);
    expect(task?.validate?.[0]).toEqual({
      type: 'llm_judge',
      prompt: 'Is it correct?',
    });
  });

  it('parses bash validator', () => {
    const content = `---
description: Test agent
sequence:
  - name: task-one
    prompt: Do something
    validate:
      - type: bash
        command: npm test
---`;

    const result = parseFrontmatter(content);
    const task = result?.sequence?.[0];
    expect(task?.validate?.[0]).toEqual({
      type: 'bash',
      command: 'npm test',
    });
  });

  it('parses tool_call validator', () => {
    const content = `---
description: Test agent
sequence:
   - name: task-one
     prompt: Do something
     validate:
       - type: tool_call
         tool: bash
         count: 2
---`;

    const result = parseFrontmatter(content);
    const task = result?.sequence?.[0];
    expect(task?.validate?.[0]).toEqual({
      type: 'tool_call',
      tool: 'bash',
      count: 2, // Note: YAML parses as number
    });
  });

  it('parses multiple validation rules', () => {
    const content = `---
description: Test agent
sequence:
  - name: task-one
    prompt: Do something
    validate:
      - type: llm_judge
        prompt: Is it correct?
      - type: bash
        command: npm test
---`;

    const result = parseFrontmatter(content);
    const task = result?.sequence?.[0];
    expect(task?.validate).toHaveLength(2);
    expect(task?.validate?.[0]?.type).toBe('llm_judge');
    expect(task?.validate?.[1]?.type).toBe('bash');
  });

  it('returns null if no frontmatter found', () => {
    const content = 'Just some text without frontmatter';
    const result = parseFrontmatter(content);
    expect(result).toBeNull();
  });

  it('returns null if frontmatter has no description', () => {
    const content = `---
some_key: some_value
---`;
    const result = parseFrontmatter(content);
    expect(result).toBeNull();
  });

  it('handles quoted values in YAML', () => {
    const content = `---
description: "Test agent"
sequence:
  - name: "task-one"
    prompt: "Do task one"
---`;

    const result = parseFrontmatter(content);
    const task = result?.sequence?.[0];
    expect(task?.name).toBe('task-one');
    expect(task?.prompt).toBe('Do task one');
  });

  it('ignores comments in YAML', () => {
    const content = `---
description: Test agent
# This is a comment
sequence:
  - name: task-one
    prompt: Do task one
---`;

    const result = parseFrontmatter(content);
    expect(result?.sequence).toHaveLength(1);
  });

  it('parses sequence with and without validation in same list', () => {
    const content = `---
description: Test agent
sequence:
  - name: task-one
    prompt: Do task one
  - name: task-two
    prompt: Do task two
    validate:
      - type: bash
        command: echo ok
  - name: task-three
    prompt: Do task three
---`;

    const result = parseFrontmatter(content);
    expect(result?.sequence).toHaveLength(3);
    expect(result?.sequence?.[0]?.validate).toEqual([]);
    expect(result?.sequence?.[1]?.validate).toHaveLength(1);
    expect(result?.sequence?.[2]?.validate).toEqual([]);
  });
});
