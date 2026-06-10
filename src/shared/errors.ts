export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 500);
    this.name = 'ConfigError';
  }
}

export class ToolError extends AppError {
  constructor(message: string, code: string = 'TOOL_ERROR') {
    super(message, code, 500);
    this.name = 'ToolError';
  }
}

export class ToolTimeoutError extends ToolError {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`, 'TOOL_TIMEOUT');
    this.name = 'ToolTimeoutError';
  }
}

export class FeishuError extends AppError {
  constructor(message: string, code: string = 'FEISHU_ERROR') {
    super(message, code, 502);
    this.name = 'FeishuError';
  }
}

export class MemoryError extends AppError {
  constructor(message: string, code: string = 'MEMORY_ERROR') {
    super(message, code, 500);
    this.name = 'MemoryError';
  }
}
