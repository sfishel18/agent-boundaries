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
 * Analyzes the conversation history to judge if the task was completed successfully.
 * 
 * Note: This is a heuristic validation that checks conversation quality without
 * blocking on an LLM response (which would deadlock inside a tool execution).
 * The validation looks for indicators that the task was completed well.
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
    // Fetch recent messages to analyze
    const response = await client.session.messages({ path: { id: sessionID } });
    const messages = response.data || [];

    if (messages.length === 0) {
      throw new Error('No conversation history to validate against');
    }

    // Get the last assistant message (the task output)
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      throw new Error('No task output found in conversation');
    }

    // Extract text content from the message
    const taskOutput = lastMessage.parts
      .filter((p): p is any => p.type === 'text')
      .map((p) => p.text)
      .join('\n');

    if (!taskOutput) {
      throw new Error('Task output contains no text content');
    }

    // Heuristic validation: Check for signs of task completion
    // This is a simple implementation - in production you might want more sophisticated checks
    
    // Check if output is substantial (not just a one-liner)
    const outputLength = taskOutput.trim().length;
    if (outputLength < 20) {
      throw new Error(`Task output appears incomplete or too brief (${outputLength} chars). Please provide a more detailed response.`);
    }

    // Check for common rejection patterns that indicate incomplete work
    const rejectionPatterns = [
      /i cannot/i,
      /i don't know/i,
      /i'm not able/i,
      /cannot complete/i,
      /not possible/i,
      /unable to/i,
    ];

    for (const pattern of rejectionPatterns) {
      if (pattern.test(taskOutput)) {
        throw new Error(`Task output indicates inability to complete: "${taskOutput.substring(0, 100)}..."`);
      }
    }

    // Log successful validation
    await client.app.log({
      body: {
        service: 'opencode-plugin-boundaries',
        level: 'debug',
        message: 'LLM judge validation passed',
        extra: { agent, outputLength },
      },
    });
  } catch (err) {
    // Re-throw with context if it's our validation error
    if (err instanceof Error && err.message.startsWith('Task') || err instanceof Error && err.message.includes('validation')) {
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
