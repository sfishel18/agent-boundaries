import { readFileSync } from 'fs';
import { splitIntoCommands } from '../../shared/parser';

interface HookInput {
  tool_input?: {
    command?: string;
    description?: string;
  };
}

const input: HookInput = JSON.parse(readFileSync(0, 'utf8'));

const description = input.tool_input?.description ?? '';
if (description.trimStart().startsWith('(Ignoring reminder)')) {
  process.exit(0);
}

const command = input.tool_input?.command ?? '';
if (!command) {
  process.exit(0);
}

const reminderStrings: string[] = JSON.parse(
  process.env['CLAUDE_PLUGIN_OPTION_REMINDERS'] ?? '[]',
);

if (reminderStrings.length === 0) {
  process.exit(0);
}

const reminders: Array<{ pattern: RegExp; message: string }> = [];
for (let i = 0; i < reminderStrings.length; i++) {
  const str = reminderStrings[i]!;
  const arrowIndex = str.indexOf(' -> ');
  if (arrowIndex === -1) {
    process.stderr.write(`Invalid reminder format at index ${i}: "${str}"\n`);
    process.exit(1);
  }
  const pattern = str.slice(0, arrowIndex).trim();
  const message = str.slice(arrowIndex + 4).trim();
  if (!pattern || !message) {
    process.stderr.write(`Invalid reminder format at index ${i}: "${str}"\n`);
    process.exit(1);
  }
  try {
    reminders.push({ pattern: new RegExp(`^(${pattern})`), message });
  } catch (err) {
    process.stderr.write(
      `Invalid regex pattern at index ${i}: "${pattern}" - ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

const primitives = splitIntoCommands(command);

for (const primitive of primitives) {
  for (const reminder of reminders) {
    if (reminder.pattern.test(primitive)) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `Reminder: ${reminder.message}\n\nIf you want to run this command anyway, set the tool call description to start with "(Ignoring reminder)" to bypass this check.`,
          },
        }),
      );
      process.exit(0);
    }
  }
}

process.exit(0);
