# Spec Delta

## Purpose

Lets the voice agent perform actions beyond conversation — starting with appointment booking — through declaratively defined skills: YAML manifests describe callable tools, a registry exposes them to the LLM as OpenAI-compatible tool definitions, and a dispatcher validates and executes invocations with a full audit trail.

## ADDED Requirements

### Requirement: YAML skill manifests
The system SHALL load skill definitions from YAML manifests in a configurable directory, each declaring a name, an LLM-facing description, a JSON Schema for its parameters, an execution type (`http`, `db`, or `rag`), an auth reference, and optional policies such as `requires_confirmation`. Manifests that fail validation SHALL be rejected at load time with a logged error and SHALL NOT be offered to the model.

#### Scenario: Valid manifest directory loads
- **WHEN** the service starts with a skills directory containing valid manifests
- **THEN** every valid skill is loaded and callable during conversations

#### Scenario: Invalid manifest is rejected
- **WHEN** a manifest is missing a required field or carries an invalid JSON Schema
- **THEN** it is rejected with a logged error naming the file, the service still boots, and the broken skill is absent from the tools array

### Requirement: Tools array generation
The system SHALL generate an OpenAI-compatible tools array from the loaded manifests — one function definition per skill carrying its name, description, and JSON Schema parameters — for injection into conversation model requests.

#### Scenario: Model can call a loaded skill
- **WHEN** a conversation turn runs for a call with skills loaded
- **THEN** the model request includes the generated tool definitions and the model may answer with a tool call naming a loaded skill

### Requirement: Argument validation
The dispatcher SHALL validate every skill invocation's arguments against the skill's JSON Schema before execution; invalid invocations SHALL NOT be executed, SHALL be audit-logged, and SHALL return a descriptive error result to the model.

#### Scenario: Model emits malformed arguments
- **WHEN** the model calls a skill with arguments that do not match the manifest's JSON Schema
- **THEN** the skill is not executed, the refusal is audit-logged, and the model receives the validation error as the tool result

### Requirement: HTTP skill execution
For `http` skills the dispatcher SHALL execute an HTTP request against a configurable endpoint template (URL populated from the validated parameters; method, headers, and credentials from configuration and the manifest's auth reference) with a timeout, returning the response as the tool result.

#### Scenario: HTTP skill invocation reaches the configured endpoint
- **WHEN** an `http` skill is invoked with valid parameters
- **THEN** a request carrying those parameters is sent to the configured endpoint and its response is returned to the model as the tool result

#### Scenario: Endpoint failure
- **WHEN** the configured endpoint returns an error or times out
- **THEN** the failure is audit-logged and the model receives an error result it can turn into a polite spoken fallback

### Requirement: DB skill execution is read-only
For `db` skills the dispatcher SHALL execute parameterized read-only SQL views (SELECT statements with bound parameters); statements that write or modify data MUST be rejected.

#### Scenario: Read-only query returns rows
- **WHEN** a `db` skill is invoked with valid parameters
- **THEN** its parameterized SELECT runs with bound values and the resulting rows are returned as the tool result

### Requirement: RAG execution deferred
The manifest schema SHALL accept the `rag` execution type, but invoking a `rag` skill SHALL return a clear not-implemented error without executing anything.

#### Scenario: Rag skill invoked
- **WHEN** the model calls a skill whose execution type is `rag`
- **THEN** the dispatcher returns a not-implemented error result and nothing is executed

### Requirement: Confirmation policy enforced at dispatch
The dispatcher SHALL refuse to execute a skill whose manifest declares `requires_confirmation` unless the invocation carries an explicit confirmation for the current call.

#### Scenario: Confirmation-less dispatch is refused
- **WHEN** a `requires_confirmation` skill invocation reaches the dispatcher without an explicit confirmation for the current call
- **THEN** the dispatcher refuses execution and returns a confirmation-required result

### Requirement: Invocation audit trail
Every skill invocation — executed, failed, refused, or not-implemented — SHALL be recorded as a `call_events` row naming the skill, the call, the arguments, and the outcome.

#### Scenario: Invocation appears in the audit log
- **WHEN** a skill invocation is processed during a call
- **THEN** a `call_events` row records the skill name, arguments, and outcome for that call

### Requirement: Shipped booking skill
The system SHALL ship an appointment booking skill executed via `http` against a configurable calendar endpoint (no vendor SDK or integration), accepting at least date/time and service parameters and returning the booking result; the endpoint URL and credentials come from configuration and are mockable for tests.

#### Scenario: Caller books an appointment
- **WHEN** the caller asks to book an appointment and provides the needed details
- **THEN** the agent calls the booking skill with those details, the configured endpoint responds, and the agent confirms the booking to the caller in the caller's language
