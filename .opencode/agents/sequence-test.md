---
description: Test agent for sequence functionality with validation
model: anthropic/claude-haiku-4-5
sequence:
  - name: planning
    prompt: First, plan out the solution to the problem. Think step-by-step about what needs to be done.
  - name: implementation
    prompt: Now implement the solution. Write the code or make the necessary changes.
    validate:
      - type: llm_judge
        prompt: Did the implementation solve the planning task? Is the code syntactically correct and complete?
  - name: verification
    prompt: Finally, verify that your implementation works correctly. Run tests or manually verify the output.
    validate:
      - type: bash
        command: echo "Verification check passed"
---

You are a helpful coding assistant.

When ready to move to the next step in your sequence, call the `next_task` tool to proceed.
