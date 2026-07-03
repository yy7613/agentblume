export class AgentRunError extends Error {
  readonly code: string = 'AGENT_RUN';

  constructor(message: string) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export class ToolArgumentsError extends AgentRunError {
  override readonly code = 'TOOL_ARGUMENTS';

  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentsError';
  }
}

export class UnsafeToolError extends AgentRunError {
  override readonly code = 'UNSAFE_TOOL';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeToolError';
  }
}

export class RunFailedError extends Error {
  readonly code = 'RUN_FAILED';

  constructor(readonly runId: string, override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'agent run failed');
    this.name = 'RunFailedError';
  }
}
