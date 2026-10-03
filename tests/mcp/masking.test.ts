// ---------------------------------------------------------------------------
// MCP credential masking (design doc §13.7 masking rule, §18 P3 acceptance)
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  MASKED_SECRET,
  isMaskedValue,
  isSecretKey,
  maskMcpSection,
  maskRecord,
  maskSecretValue,
  maskServerConfig,
} from '../../src/mcp/masking.js';
import type {
  McpHttpServerConfig,
  McpSectionConfig,
  McpStdioServerConfig,
} from '../../src/mcp/types.js';

function stdioServer(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    name: 'filesystem',
    enabled: true,
    exposure: 'deferred',
    toolExposure: {},
    description: 'local fs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: {},
    cwd: '',
    ...overrides,
  };
}

function httpServer(overrides: Partial<McpHttpServerConfig> = {}): McpHttpServerConfig {
  return {
    name: 'docs',
    enabled: true,
    exposure: 'deferred',
    toolExposure: {},
    description: 'docs',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: {},
    ...overrides,
  };
}

describe('isSecretKey', () => {
  it('matches the documented rule: Authorization, *_TOKEN, *_SECRET, *_KEY', () => {
    expect(isSecretKey('Authorization')).toBe(true);
    expect(isSecretKey('authorization')).toBe(true);
    expect(isSecretKey('GITHUB_TOKEN')).toBe(true);
    expect(isSecretKey('DOCS_SECRET')).toBe(true);
    expect(isSecretKey('SERVICE_KEY')).toBe(true);
  });

  it('matches hyphenated and camelCase spellings', () => {
    expect(isSecretKey('X-Api-Key')).toBe(true);
    expect(isSecretKey('x_api_key')).toBe(true);
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('accessToken')).toBe(true);
    expect(isSecretKey('clientSecret')).toBe(true);
  });

  it('does not mask ordinary keys', () => {
    expect(isSecretKey('Content-Type')).toBe(false);
    expect(isSecretKey('Accept')).toBe(false);
    expect(isSecretKey('USER')).toBe(false);
    expect(isSecretKey('MONKEY')).toBe(false);
    expect(isSecretKey('')).toBe(false);
  });
});

describe('maskSecretValue / isMaskedValue', () => {
  it('replaces non-empty values with the placeholder', () => {
    expect(maskSecretValue('super-secret')).toBe(MASKED_SECRET);
    expect(maskSecretValue('')).toBe('');
  });

  it('recognises the placeholder so callers can leave a stored secret alone', () => {
    expect(isMaskedValue(MASKED_SECRET)).toBe(true);
    expect(isMaskedValue('real-secret')).toBe(false);
    expect(isMaskedValue(undefined)).toBe(false);
  });
});

describe('maskRecord', () => {
  it('masks secret keys and leaves the rest verbatim', () => {
    const masked = maskRecord({ Authorization: 'Bearer abc', 'X-Api-Key': 'k', USER: 'alice' });
    expect(masked).toEqual({
      Authorization: MASKED_SECRET,
      'X-Api-Key': MASKED_SECRET,
      USER: 'alice',
    });
  });

  it('is undefined-safe', () => {
    expect(maskRecord(undefined)).toBeUndefined();
  });
});

describe('maskServerConfig', () => {
  it('masks stdio env secrets but keeps non-secrets', () => {
    const masked = maskServerConfig(
      stdioServer({ env: { GITHUB_TOKEN: 'ghp_x', LOG_LEVEL: 'debug' } }),
    );
    expect(masked.transport).toBe('stdio');
    if (masked.transport !== 'stdio') throw new Error('unreachable');
    expect(masked.env).toEqual({ GITHUB_TOKEN: MASKED_SECRET, LOG_LEVEL: 'debug' });
  });

  it('masks HTTP header secrets', () => {
    const masked = maskServerConfig(
      httpServer({ headers: { Authorization: 'Bearer abc', Accept: 'application/json' } }),
    );
    expect(masked.transport).toBe('http');
    if (masked.transport !== 'http') throw new Error('unreachable');
    expect(masked.headers).toEqual({ Authorization: MASKED_SECRET, Accept: 'application/json' });
  });

  it('masks the OAuth client secret but keeps the client id', () => {
    const masked = maskServerConfig(
      httpServer({
        oauth: {
          clientId: 'public-client',
          clientSecret: 'shh',
          callbackPort: 8765,
          callbackUrl: '',
          scope: '',
          clientName: '',
          authServerMetadataUrl: '',
        },
      }),
    );
    expect(masked.oauth?.clientSecret).toBe(MASKED_SECRET);
    expect(masked.oauth?.clientId).toBe('public-client');
  });

  it('never mutates the input', () => {
    const original = stdioServer({ env: { GITHUB_TOKEN: 'ghp_x' } });
    maskServerConfig(original);
    expect(original.env.GITHUB_TOKEN).toBe('ghp_x');
  });
});

describe('maskMcpSection', () => {
  const section: McpSectionConfig = {
    enabled: true,
    connectTimeoutSec: 15,
    requestTimeoutSec: 60,
    maxOutputBytes: 20480,
    maxConcurrentConnects: 4,
    injectSystemPrompt: true,
    allowServers: [],
    denyServers: [],
    servers: {
      filesystem: stdioServer({ env: { GITHUB_TOKEN: 'ghp_x' } }),
      docs: httpServer({ headers: { Authorization: 'Bearer abc' } }),
    },
  };

  it('masks every server and preserves section scalars', () => {
    const masked = maskMcpSection(section);
    expect(masked?.maxOutputBytes).toBe(20480);
    expect(Object.keys(masked?.servers ?? {}).sort()).toEqual(['docs', 'filesystem']);
    const fs = masked?.servers.filesystem;
    if (fs?.transport !== 'stdio') throw new Error('unreachable');
    expect(fs.env.GITHUB_TOKEN).toBe(MASKED_SECRET);
  });

  it('leaves the original section untouched', () => {
    maskMcpSection(section);
    const fs = section.servers.filesystem;
    if (fs.transport !== 'stdio') throw new Error('unreachable');
    expect(fs.env.GITHUB_TOKEN).toBe('ghp_x');
  });

  it('is undefined-safe', () => {
    expect(maskMcpSection(undefined)).toBeUndefined();
  });
});
