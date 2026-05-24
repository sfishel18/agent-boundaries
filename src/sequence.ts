import { z } from 'zod';
import type { Config } from '@opencode-ai/plugin';

/**
 * Validation rule to check before advancing to the next task
 */
export interface ValidationRule {
  type: 'llm_judge' | 'tool_call' | 'bash';
  [key: string]: unknown;
}

/**
 * Represents a single task in a sequence
 */
export interface SequenceTask {
  name: string;
  prompt: string;
  validate?: ValidationRule[];
}

/**
 * Zod schema for validating sequence tasks at runtime
 * Ensures that sequence definitions conform to the expected structure:
 * {
 *   agent: {
 *     "agent-name": {
 *       sequence: [
 *         {
 *           name: string;
 *           prompt: string;
 *           validate?: Array<{ type: 'llm_judge' | 'tool_call' | 'bash'; ... }>
 *         }
 *       ]
 *     }
 *   }
 * }
 */
const ValidationRuleSchema = z.object({
  type: z.enum(['llm_judge', 'tool_call', 'bash']),
}).passthrough();

const SequenceTaskSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  validate: z.array(ValidationRuleSchema).optional(),
});

const SequenceSchema = z.array(SequenceTaskSchema);

/**
 * Read and parse the sequence from an agent's OpenCode configuration.
 * 
 * @param agentName The name of the agent (e.g., "my-agent")
 * @param config The OpenCode plugin configuration
 * @returns The validated sequence tasks, or null if not found or no sequence defined
 * @throws {z.ZodError} If the sequence configuration is invalid
 */
export async function readAgentSequence(
  agentName: string,
  config: Config | undefined,
): Promise<SequenceTask[] | null> {
  const agentConfig = config?.agent?.[agentName];
  
  if (!agentConfig?.sequence) {
    return null;
  }

  // Validate the sequence structure at runtime
  return SequenceSchema.parse(agentConfig.sequence);
}
