import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HookInput {
  session_id: string;
  transcript_path: string;
  agent_type?: string;
  cwd?: string;
}

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface ToolUseBlock extends ContentBlock {
  type: 'tool_use';
  name: string;
}

interface TranscriptLine {
  role?: string;
  content?: ContentBlock[] | string;
  [key: string]: unknown;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ValidatorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bash'), command: z.string() }),
  z.object({ type: z.literal('tool_call'), tool: z.string() }),
  z.object({ type: z.literal('human_approval'), message: z.string() }),
  z.object({
    type: z.literal('llm_judge'),
    criteria: z.string(),
    model: z.string().optional(),
  }),
]);

const TaskSchema = z.object({
  prompt: z.string(),
  validators: z.array(ValidatorSchema).optional(),
});

export const SequenceSchema = z.array(TaskSchema);
export type Sequence = z.infer<typeof SequenceSchema>;
export type Task = z.infer<typeof TaskSchema>;

// ─── State file ───────────────────────────────────────────────────────────────

export interface SharedState {
  pending_task_index: number;
  task_start_lines: number;
  sequence: Sequence;
  agent_type: string;
}

export function statePath(sessionId: string): string {
  return `/tmp/agent-boundaries-${sessionId}.json`;
}

function readState(sessionId: string): SharedState | null {
  const path = statePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SharedState;
  } catch {
    return null;
  }
}

// ─── Agent file discovery ─────────────────────────────────────────────────────

function findAgentFile(agentType: string, cwd: string): string | null {
  const home = process.env['HOME'] ?? '';
  const candidates = [
    join(cwd, '.claude', 'agents', `${agentType}.md`),
    join(home, '.claude', 'agents', `${agentType}.md`),
  ];
  return candidates.find(existsSync) ?? null;
}

function parseSequenceFromFile(filePath: string): Sequence | null {
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = yaml.load(match[1]!) as Record<string, unknown>;
  if (!frontmatter?.sequence) return null;

  return SequenceSchema.parse(frontmatter.sequence);
}

// ─── Transcript parsing ───────────────────────────────────────────────────────

interface ToolCallEntry {
  line: number;
  name: string;
}

function parseTranscript(transcriptPath: string): {
  lineCount: number;
  toolCalls: ToolCallEntry[];
} {
  const rawLines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const toolCalls: ToolCallEntry[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    try {
      const entry = JSON.parse(rawLines[i]!) as TranscriptLine;
      const blocks = Array.isArray(entry.content) ? entry.content : [];
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          toolCalls.push({ line: i, name: (block as ToolUseBlock).name });
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return { lineCount: rawLines.length, toolCalls };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateToolCalls(task: Task, toolCallNames: string[]): string | null {
  for (const validator of task.validators ?? []) {
    if (validator.type !== 'tool_call') continue;
    const pattern = new RegExp(validator.tool);
    if (!toolCallNames.some((name) => pattern.test(name))) {
      return `No call to tool matching "${validator.tool}" was found since this task started.`;
    }
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const input: HookInput = JSON.parse(readFileSync(0, 'utf8'));
const { session_id, transcript_path, agent_type, cwd = process.cwd() } = input;

if (!agent_type) process.exit(0);

// Load sequence from agent frontmatter
const agentFile = findAgentFile(agent_type, cwd);
if (!agentFile) process.exit(0);

let sequence: Sequence;
try {
  const parsed = parseSequenceFromFile(agentFile);
  if (!parsed) process.exit(0);
  sequence = parsed;
} catch (err) {
  process.stderr.write(
    `agent-boundaries: invalid sequence in ${agentFile}: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

// Read existing state (source of truth for task index)
const state = readState(session_id);
const N = state?.pending_task_index ?? 0;
const taskStartLines = state?.task_start_lines ?? 0;

// Sequence already exhausted
if (N >= sequence.length) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Sequence already complete. No more tasks.',
      },
    }),
  );
  process.exit(0);
}

// Validate tool_call requirements for the task being completed
if (N > 0) {
  const { lineCount, toolCalls } = parseTranscript(transcript_path);
  const toolCallsSinceStart = toolCalls
    .filter((tc) => tc.line >= taskStartLines)
    .map((tc) => tc.name);

  const error = validateToolCalls(sequence[N - 1]!, toolCallsSinceStart);
  if (error) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Task validation failed: ${error}\n\nComplete the required actions and call \`next_task\` again.`,
        },
      }),
    );
    process.exit(0);
  }

  // Write state with updated task_start_lines (scoping for next task's tool_call validators)
  const newState: SharedState = {
    pending_task_index: N,
    task_start_lines: lineCount,
    sequence,
    agent_type,
  };
  writeFileSync(statePath(session_id), JSON.stringify(newState));
} else {
  // First call — write initial state
  const { lineCount } = parseTranscript(transcript_path);
  const newState: SharedState = {
    pending_task_index: 0,
    task_start_lines: lineCount,
    sequence,
    agent_type,
  };
  writeFileSync(statePath(session_id), JSON.stringify(newState));
}

process.exit(0);
