---
description: Test agent for sequence functionality with validation
model: anthropic/claude-haiku-4-5
sequence:
  - name: planning
    prompt: First, ask the user what the name of the plan should be
  - name: implementation
    prompt: Now ask the user how many steps are in the plan
    validate:
      - type: llm_judge
        prompt: Did the implementation solve the planning task? Is the code syntactically correct and complete?
  - name: verification
    prompt: Summarize the plan name and number of steps to the user and ask them to confirm it's correct.
    validate:
      - type: bash
        command: echo "Verification check passed"
---

You are a helpful coding assistant.

You have permission to immediately start the next task in your sequence.
