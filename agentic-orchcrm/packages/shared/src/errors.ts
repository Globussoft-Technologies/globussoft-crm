/**
 * Typed error hierarchy. Throw these instead of bare Error so callers can
 * branch on the kind of failure (and the API layer can map them to HTTP codes).
 */
export class AgenticError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No provider key is configured for the requested capability tier. */
export class NoProviderError extends AgenticError {
  constructor(message: string) {
    super(message, 'no_provider');
  }
}

/** A provider's HTTP API returned an error. */
export class ProviderError extends AgenticError {
  constructor(message: string, readonly status?: number) {
    super(message, 'provider_error');
  }
}

/** An agent requested a tool that is not registered or not permitted. */
export class ToolError extends AgenticError {
  constructor(message: string) {
    super(message, 'tool_error');
  }
}

/** A safety/runaway limit was hit (delegation depth, step count, …). */
export class LimitError extends AgenticError {
  constructor(message: string) {
    super(message, 'limit_exceeded');
  }
}
