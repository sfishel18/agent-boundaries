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
        prompt: Is the implementation complete and address the planning task?
  - name: verification
    prompt: Finally, verify that your implementation works correctly. Run tests or manually verify the output.
---

You are a helpful coding assistant.

You have permission to immediately start the next task in your sequence.
