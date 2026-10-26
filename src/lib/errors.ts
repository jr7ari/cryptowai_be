export class EngineError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Raised when a feature is not verifiably supported by the exchange API. Never retried. */
export class CapabilityUnavailableError extends EngineError {
  constructor(capability: string, details?: unknown) {
    super(`Capability not available/verified: ${capability}`, 'CAPABILITY_UNAVAILABLE', details);
  }
}

export class RiskViolationError extends EngineError {
  constructor(message: string, details?: unknown) {
    super(message, 'RISK_VIOLATION', details);
  }
}

export class StaleDataError extends EngineError {
  constructor(message: string, details?: unknown) {
    super(message, 'STALE_DATA', details);
  }
}

export class ExchangeError extends EngineError {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly retryable: boolean,
    details?: unknown,
  ) {
    super(message, 'EXCHANGE_ERROR', details);
  }
}

export class KillSwitchError extends EngineError {
  constructor(reason: string) {
    super(`Kill switch engaged: ${reason}`, 'KILL_SWITCH');
  }
}

export class ConfigError extends EngineError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIG_ERROR', details);
  }
}
