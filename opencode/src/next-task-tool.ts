import { tool } from '@opencode-ai/plugin';
import type { Config, PluginInput, ToolContext } from '@opencode-ai/plugin';
import { readAgentSequence } from './sequence';
import { validateTask } from './validators';

type OpencodeClient = PluginInput['client'];

/**
 * Part type from OpenCode API
 * Extracted from the broader API types
 */
export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: { [key: string]: unknown };
}

export type ToolState =
  | { status: 'pending'; input: Record<string, unknown>; raw: string }
  | {
      status: 'running';
      input: Record<string, unknown>;
      title?: string;
      metadata?: Record<string, unknown>;
      time: { start: number };
    }
  | {
      status: 'completed';
      input: Record<string, unknown>;
      output: string;
      title: string;
      metadata: Record<string, unknown>;
      time: { start: number; end: number; compacted?: number };
      attachments?: unknown[];
    }
  | {
      status: 'error';
      input: Record<string, unknown>;
      error: string;
      metadata?: Record<string, unknown>;
      time: { start: number; end: number };
    };

export interface Part {
  type: string;
  [key: string]: unknown;
}

export interface MessageParts {
  info: unknown;
  parts: Part[];
}

/**
 * Count the number of completed next_task calls in the session history
 * This determines the current task index (0-based)
 */
function countCompletedNextTaskCalls(messages: MessageParts[]): number {
  const toolParts = messages
    .flatMap(({ parts }) => parts)
    .filter(
      (p): p is ToolPart =>
        p.type === 'tool' &&
        p.tool === 'next_task' &&
        p.state.status === 'completed',
    );

  return toolParts.length;
}

/**
 * Create the next_task tool
 */
export function createNextTaskTool(
  client: OpencodeClient,
  configRef: { current: Config | undefined },
) {
  return tool({
    description:
      'Call this when you have completed your current task to receive your next task.',
    args: {},
    async execute(_args, context: ToolContext) {
      const { sessionID, agent, directory } = context;

      // Read and validate the sequence from the agent's configuration
      const sequence = await readAgentSequence(agent, configRef.current);

      if (!sequence) {
        return 'This agent has no sequence defined.';
      }

      // Fetch the session's message history
      let messages: MessageParts[];
      try {
        const response = await client.session.messages({
          path: { id: sessionID },
        });
        messages = response.data || [];
      } catch (err) {
        // If we can't fetch history, we can at least try to bootstrap task 0
        messages = [];
      }

      // Count completed calls to determine current position
      const N = countCompletedNextTaskCalls(messages);

      // Check if we've completed the sequence
      if (N >= sequence.length) {
        return 'Sequence complete. No more tasks.';
      }

      // Validate the current task before advancing
      if (N > 0) {
        const currentTask = sequence[N - 1];
        try {
          await validateTask(client, currentTask, sessionID, agent, directory);
        } catch (err) {
          // Re-throw validation error - this causes the tool call to fail
          // and the error status prevents N from incrementing
          throw err;
        }
      }

      // Return the next task's prompt
      const task = sequence[N];
      const nextTask = sequence[N + 1];
      return `
      ## Task ${N + 1}: ${task.name}
      
      ${task.prompt}. 
      
      When you have completed this task, YOU MUST ALWAYS STOP and call \`next_task\` again to receive instructions for the ${nextTask?.name ?? 'next'} task.
      DO NOT attempt to work ahead or skip steps. Skipping ahead IS NOT HELPFUL, it's counterproductive.`;
    },
  });
}
