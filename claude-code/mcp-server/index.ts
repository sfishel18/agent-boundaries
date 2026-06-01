import { readFileSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { SharedState } from '../scripts/next-task-hook.js';
import { statePath } from '../scripts/next-task-hook.js';

// ─── State ────────────────────────────────────────────────────────────────────

function readState(sessionId: string): SharedState | null {
  const path = statePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SharedState;
  } catch {
    return null;
  }
}

function advanceState(state: SharedState, sessionId: string): void {
  writeFileSync(
    statePath(sessionId),
    JSON.stringify({
      ...state,
      pending_task_index: state.pending_task_index + 1,
    }),
  );
}

// ─── Validators ───────────────────────────────────────────────────────────────

async function validateBash(command: string, cwd: string): Promise<string | null> {
  try {
    execSync(command, { cwd, stdio: 'pipe' });
    return null;
  } catch {
    return `\`${command}\` exited with non-zero status`;
  }
}

async function validateLLMJudge(
  criteria: string,
  model: string,
  apiKey: string,
): Promise<string | null> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Evaluate whether the following criteria has been met based on the work done so far in this task. Respond ONLY with JSON.\n\nCriteria: ${criteria}\n\nJSON format: {"valid": true|false, "reason": "one sentence"}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    return `llm_judge: API request failed (${response.status})`;
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.[0]?.text ?? '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      valid?: boolean;
      reason?: string;
    };
    return result.valid ? null : `llm_judge: ${result.reason ?? 'criteria not met'}`;
  } catch {
    return `llm_judge: could not parse response`;
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'agent-boundaries', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'next_task',
      description:
        'Call this when you have completed your current task to receive your next task. Do not call this until you have fully completed all work for the current task.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'next_task') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const sessionId = process.env['CLAUDE_CODE_SESSION_ID'];
  if (!sessionId) {
    return { content: [{ type: 'text', text: 'This agent has no sequence defined.' }] };
  }

  const state = readState(sessionId);
  if (!state) {
    return { content: [{ type: 'text', text: 'This agent has no sequence defined.' }] };
  }

  const { pending_task_index: N, sequence } = state;
  const cwd = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();

  if (N >= sequence.length) {
    return { content: [{ type: 'text', text: 'Sequence complete. No more tasks.' }] };
  }

  // Run non-transcript validators for the completed task
  if (N > 0) {
    const completedTask = sequence[N - 1]!;
    const errors: string[] = [];

    for (const validator of completedTask.validators ?? []) {
      if (validator.type === 'bash') {
        const err = await validateBash(validator.command, cwd);
        if (err) errors.push(err);
      } else if (validator.type === 'llm_judge') {
        const apiKey = process.env['ANTHROPIC_API_KEY'];
        if (!apiKey) {
          errors.push('llm_judge: ANTHROPIC_API_KEY is not set');
        } else {
          const model = validator.model ?? 'claude-haiku-4-5-20251001';
          const err = await validateLLMJudge(validator.criteria, model, apiKey);
          if (err) errors.push(err);
        }
      } else if (validator.type === 'human_approval') {
        // TODO: implement via MCP elicitation
        // server.createElicitation({ message: validator.message, ... })
        errors.push(`human_approval validator is not yet implemented`);
      }
      // tool_call: handled by PreToolUse hook before this runs
    }

    if (errors.length > 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Task validation failed:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nFix the issues above and call \`next_task\` again.`,
          },
        ],
        isError: true,
      };
    }
  }

  // Advance state and return next task prompt
  advanceState(state, sessionId);

  const task = sequence[N]!;
  const nextTask = sequence[N + 1];
  const taskNumber = N + 1;
  const taskTotal = sequence.length;

  const nextInstruction = nextTask
    ? `When you have completed this task, call \`next_task\` to receive task ${taskNumber + 1}.`
    : `This is the final task. When complete, call \`next_task\` to confirm completion.`;

  return {
    content: [
      {
        type: 'text',
        text: `## Task ${taskNumber} of ${taskTotal}\n\n${task.prompt}\n\n${nextInstruction}\n\nDO NOT work ahead or attempt future tasks.`,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
