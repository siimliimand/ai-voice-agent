# Spec Delta

## ADDED Requirements

### Requirement: Tool-calling conversation loop
The conversation agent SHALL run a multi-step tool-calling loop within a turn: model tool calls are dispatched through the skills framework, their results are appended as tool messages, and the model continues until it produces a spoken reply or the iteration bound is reached. The bound SHALL be configurable; exceeding it SHALL end the loop with a graceful spoken fallback rather than a dangling tool call. The loop SHALL abort on barge-in like any reply stream.

#### Scenario: Tool call round-trips
- **WHEN** the model emits a tool call for a loaded skill
- **THEN** the skill executes, its result is fed back to the model as a tool message, and the conversation continues to a spoken reply

#### Scenario: Iteration bound reached
- **WHEN** the model keeps emitting tool calls until the configured iteration bound is hit
- **THEN** no further tool calls are dispatched and the caller hears a graceful spoken fallback

#### Scenario: Barge-in during the tool loop
- **WHEN** the caller starts speaking while a tool-call iteration is in flight
- **THEN** the loop aborts like an interrupted reply and no orphaned tool outcome is spoken afterwards

### Requirement: Confirmation-gated skill execution
For skills whose policy requires confirmation, the loop SHALL have the agent ask the caller to confirm (in the call language) and SHALL dispatch the skill only after an affirmative caller reply in a later turn; a decline, an unrelated reply, or an interruption cancels the pending dispatch. Confirmation SHALL NOT be auto-extracted from the same model turn that requested the skill.

#### Scenario: Caller confirms and the skill proceeds
- **WHEN** the agent asks for confirmation and the caller answers affirmatively
- **THEN** the pending skill is dispatched with the confirmed arguments and the agent speaks the outcome

#### Scenario: Caller declines
- **WHEN** the caller answers negatively or with something other than an affirmation
- **THEN** the pending skill is not dispatched and the conversation continues without it

#### Scenario: Interruption cancels a pending confirmation
- **WHEN** the caller interrupts while a confirmation question is pending
- **THEN** the pending dispatch is cancelled

### Requirement: Escalation trigger
The system prompt SHALL guide the agent to hand the call to a human when the caller asks for one or the agent judges the request beyond its capabilities, and the agent SHALL be able to trigger that handover as an explicit action whose effect is the escalation call flow rather than a conversational reply.

#### Scenario: Caller asks for a human
- **WHEN** the caller explicitly asks to speak with a person
- **THEN** the agent triggers the escalation flow instead of continuing to handle the request itself

#### Scenario: Agent escalates on its own judgment
- **WHEN** the caller's request exceeds the agent's scope per the prompt guidance
- **THEN** the agent can trigger the same escalation flow without an explicit caller request
