import type { OpencodeClient } from '@opencode-ai/plugin';
import type { ValidationRule, SequenceTask } from './sequence';

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
 * Validate using an LLM judge via an ephemeral child session.
 *
 * Creates a separate child session, sends the validation prompt to it, reads
 * the structured output from the response, then deletes the child session.
 * Because the child session is independent, there is no deadlock with the
 * main session that is currently executing.
 */
async function validateWithLLMJudge(
  client: OpencodeClient,
  rule: ValidationRule,
  sessionID: string,
  agent: string,
): Promise<void> {
  const judgePrompt = (rule.prompt || rule.judge_prompt) as string | undefined;
  if (!judgePrompt) {
    throw new Error('llm_judge validation requires a "prompt" field');
  }

  const modelOverride = rule.model as { providerID: string; modelID: string } | undefined;

  // Fetch recent messages from the main session to give the judge context
  const messagesResponse = await client.session.messages({ path: { id: sessionID } });
  const messages = (messagesResponse.data || []) as Array<{ info: any; parts: any[] }>;

  // Build a transcript of the recent conversation (last 6 messages)
  const transcript = messages
    .slice(-6)
    .map(({ info, parts }) => {
      const role = info?.role === 'assistant' ? 'Assistant' : 'User';
      const text = parts
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('\n');
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n\n');

  if (!transcript) {
    throw new Error('llm_judge: no conversation content to validate against');
  }

  let childSessionID: string | null = null;

  try {
    // Create an ephemeral child session
    const createResponse = await client.session.create({
      body: { parentID: sessionID },
    });
    childSessionID = (createResponse as any).data?.id;
    if (!childSessionID) {
      throw new Error('llm_judge: failed to create child session for validation');
    }

    // Send the validation prompt to the child session with structured output
    const promptBody: any = {
      parts: [
        {
          type: 'text',
          text: `You are a task validation judge. Review the following conversation and determine whether the task was completed successfully.\n\n## Conversation\n\n${transcript}\n\n## Validation criteria\n\n${judgePrompt}\n\nRespond only with the structured output tool.`,
        },
      ],
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            valid: { type: 'boolean', description: 'true if the task was completed successfully' },
            reason: { type: 'string', description: 'brief explanation of the judgement' },
          },
          required: ['valid', 'reason'],
        },
      },
    };

    if (modelOverride) {
      promptBody.model = modelOverride;
    }

    const promptResponse = await client.session.prompt({
      path: { id: childSessionID },
      body: promptBody,
    });

    const structured = (promptResponse as any).data?.info?.structured;
    if (!structured || typeof structured !== 'object') {
      throw new Error('llm_judge: structured output missing from judge response');
    }

    if (!structured.valid) {
      throw new Error(`llm_judge: ${structured.reason}`);
    }
  } finally {
    // Always clean up the child session
    if (childSessionID) {
      try {
        await client.session.delete({ path: { id: childSessionID } });
      } catch {
        // Non-fatal — orphaned session is cosmetic only
      }
    }
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
