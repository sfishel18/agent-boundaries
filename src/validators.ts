import type { OpencodeClient } from '@opencode-ai/plugin';
import type { ValidationRule, SequenceTask } from './sequence';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Validate that a task has been completed according to its rules
 * Throws an error if validation fails
 */
export async function validateTask(
  client: OpencodeClient,
  task: SequenceTask,
  sessionID: string,
  agent: string,
  directory: string,
): Promise<void> {
  if (!task.validate || task.validate.length === 0) {
    return;
  }

  const errors: string[] = [];

  for (const rule of task.validate) {
    try {
      if (rule.type === 'llm_judge') {
        await validateWithLLMJudge(client, rule, sessionID, agent);
      } else if (rule.type === 'bash') {
        await validateWithBash(rule, directory);
      } else if (rule.type === 'tool_call') {
        await validateWithToolCall(client, rule, sessionID);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (errors.length > 0) {
    throw new Error(`Task validation failed:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
}

/**
 * Validate using an LLM judge
 * Sends the last few messages to the LLM with a validation prompt
 */
async function validateWithLLMJudge(
  client: OpencodeClient,
  rule: ValidationRule,
  sessionID: string,
  agent: string,
): Promise<void> {
  await client.app.log({
    body: {
      service: 'opencode-plugin-boundaries',
      level: 'debug',
      message: 'Running LLM judge validation',
      extra: { agent, prompt: (rule.prompt || rule.judge_prompt) as string },
    },
  });
  const prompt = (rule.prompt || rule.judge_prompt) as string | undefined;
  if (!prompt) {
    throw new Error('llm_judge validation requires a "prompt" or "judge_prompt" field');
  }

  try {
    // Fetch recent messages to validate against
    const response = await client.session.messages({ path: { id: sessionID } });
    const messages = response.data || [];

    // Build context from last few messages
    const recentContext = messages
      .slice(-3) // Last 3 messages for context
      .flatMap(({ parts }) =>
        parts
          .filter((p): p is any => p.type === 'text')
          .map((p) => p.text),
      )
      .join('\n\n');

    // Use structured output to get a validation result
    const validationPrompt = `${prompt}\n\nRecent context:\n${recentContext}`;

    const result = await client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [
          {
            type: 'text',
            text: `[VALIDATION CHECK - Not for user response]\n${validationPrompt}\n\nRespond with JSON: {"valid": true/false, "reason": "explanation"}`,
          },
        ],
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              valid: { type: 'boolean', description: 'Whether the task passed validation' },
              reason: { type: 'string', description: 'Explanation of the validation result' },
            },
            required: ['valid', 'reason'],
          },
        },
      },
    });

    // Extract structured output from the assistant's response
    let output: any = null;
    
    // The response should contain the assistant message with parts
    if ((result as any)?.data?.parts) {
      // Look for StructuredOutput tool call result
      const structuredPart = (result as any).data.parts.find((p: any) => p.type === 'tool' && p.tool === 'StructuredOutput');
      if (structuredPart?.state?.output) {
        try {
          output = JSON.parse(structuredPart.state.output);
        } catch {
          output = structuredPart.state.output;
        }
      }
    }
    
    if (!output || typeof output !== 'object') {
      throw new Error(`Failed to extract structured validation output. Response structure: ${JSON.stringify((result as any)?.data || result).substring(0, 300)}`);
    }

    if (!output.valid) {
      throw new Error(`LLM validation failed: ${output.reason}`);
    }
  } catch (err) {
    // Re-throw with context if it's our validation error
    if (err instanceof Error && err.message.startsWith('LLM validation failed:')) {
      throw err;
    }
    // Otherwise wrap the error
    throw new Error(`Failed to run LLM judge: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Validate by running a bash command
 * Command should exit with code 0 to pass
 */
async function validateWithBash(rule: ValidationRule, directory: string): Promise<void> {
  const command = rule.command as string | undefined;
  if (!command) {
    throw new Error('bash validation requires a "command" field');
  }

  try {
    // Dynamically import Bun's shell API
    const { $ } = await import('bun');
    // Run the command in the given directory
    await $`bash -c "cd ${directory} && ${command}"`.quiet();
    // If we get here, command succeeded (exit code 0)
  } catch (err) {
    throw new Error(`Bash validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Validate by checking tool calls since the last task
 * (Phase 2 placeholder - more complex, requires filtering by timestamp)
 */
async function validateWithToolCall(
  client: OpencodeClient,
  rule: ValidationRule,
  sessionID: string,
): Promise<void> {
  const expectedTool = rule.tool as string | undefined;
  const expectedCount = rule.count as number | undefined;

  if (!expectedTool) {
    throw new Error('tool_call validation requires a "tool" field');
  }

  try {
    const response = await client.session.messages({ path: { id: sessionID } });
    const messages = response.data || [];

    // Count tool calls of the specified type in recent messages
    const toolCalls = messages
      .flatMap(({ parts }) => parts)
      .filter((p): p is any => p.type === 'tool' && p.tool === expectedTool && p.state.status === 'completed');

    if (expectedCount !== undefined && toolCalls.length < expectedCount) {
      throw new Error(
        `Expected at least ${expectedCount} calls to "${expectedTool}", found ${toolCalls.length}`,
      );
    }

    if (toolCalls.length === 0) {
      throw new Error(`No successful calls to tool "${expectedTool}" were detected`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Expected')) {
      throw err;
    }
    throw new Error(`Tool call validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
