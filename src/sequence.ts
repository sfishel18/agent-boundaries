import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Represents a single task in a sequence
 */
export interface SequenceTask {
  name: string;
  prompt: string;
  validate?: ValidationRule[];
}

/**
 * Validation rule to check before advancing to the next task
 */
export interface ValidationRule {
  type: 'llm_judge' | 'tool_call' | 'bash';
  [key: string]: unknown;
}

/**
 * Agent frontmatter structure with optional sequence field
 */
export interface AgentFrontmatter {
  description: string;
  sequence?: SequenceTask[];
  [key: string]: unknown;
}

/**
 * Parse YAML frontmatter from agent Markdown file
 */
export function parseFrontmatter(content: string): AgentFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yamlContent = match[1];
  try {
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!('description' in parsed)) return null;

    // Normalize sequence if present
    if ('sequence' in parsed && Array.isArray(parsed.sequence)) {
      parsed.sequence = parsed.sequence.map((task: any) => {
        const normalized: SequenceTask = {
          name: String(task.name || ''),
          prompt: String(task.prompt || ''),
        };
        if (task.validate && Array.isArray(task.validate)) {
          normalized.validate = task.validate.map((rule: any) => ({
            type: rule.type || 'llm_judge',
            ...rule,
          }));
        } else {
          normalized.validate = [];
        }
        return normalized;
      });
    }

    return parsed as AgentFrontmatter;
  } catch (err) {
    return null;
  }
}


/**
 * Read and parse the sequence from an agent's Markdown file
 * @param agentName The name of the agent (e.g., "my-agent")
 * @param directory The project directory containing .opencode/agents/
 * @returns The sequence tasks, or null if not found or no sequence defined
 */
export async function readAgentSequence(
  agentName: string,
  directory: string,
): Promise<SequenceTask[] | null> {
  const agentPath = path.join(directory, '.opencode', 'agents', `${agentName}.md`);

  try {
    const content = await fs.readFile(agentPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);

    if (!frontmatter) {
      return null;
    }

    return frontmatter.sequence || null;
  } catch {
    // File doesn't exist or can't be read
    return null;
  }
}
