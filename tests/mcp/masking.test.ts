// ---------------------------------------------------------------------------
// MCP credential masking (design doc §13.7 masking rule, §18 P3 acceptance)
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  MASKED_SECRET,
  containsMaskedSecret,
  isMaskedValue,
  isSecretKey,
  maskMcpSection,
  maskRecord,
  maskSecretValue,
  maskServerConfig,
  maskUrl,
  maskUrlInText,
  resolveMaskedUrl,
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
    toolEnabled: {},
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
    toolEnabled: {},
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

  it('matches separator-less all-caps concatenations but not MONKEY', () => {
    // Neither rule above sees these: no separator, and no lower-to-upper
    // boundary. The qualifier guard is what keeps `MONKEY` out.
    expect(isSecretKey('APIKEY')).toBe(true);
    expect(isSecretKey('AUTHTOKEN')).toBe(true);
    expect(isSecretKey('CLIENTSECRET')).toBe(true);
    expect(isSecretKey('MONKEY')).toBe(false);
    // Same spellings lowercased (`?apikey=` in a URL, §13.7).
    expect(isSecretKey('apikey')).toBe(true);
    expect(isSecretKey('authtoken')).toBe(true);
    expect(isSecretKey('clientsecret')).toBe(true);
    expect(isSecretKey('donkey')).toBe(false);
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

describe('maskUrl', () => {
  it('masks userinfo and secret-ish query params', () => {
    expect(maskUrl('https://svc:ghp_token@host/mcp?access_token=abc&safe=1')).toBe(
      `https://${MASKED_SECRET}@host/mcp?access_token=${MASKED_SECRET}&safe=1`,
    );
  });

  it('masks every documented query-param spelling', () => {
    const masked = maskUrl(
      'https://host/mcp?token=a&key=b&api_key=c&apikey=d&password=e&access_token=f&page=2',
    );
    expect(masked).toBe(
      `https://host/mcp?token=${MASKED_SECRET}&key=${MASKED_SECRET}&api_key=${MASKED_SECRET}` +
        `&apikey=${MASKED_SECRET}&password=${MASKED_SECRET}&access_token=${MASKED_SECRET}&page=2`,
    );
  });

  it('returns a credential-free URL byte-identically', () => {
    expect(maskUrl('https://example.com/mcp')).toBe('https://example.com/mcp');
    expect(maskUrl('https://example.com')).toBe('https://example.com');
  });

  it('falls back to a textual userinfo strip when the URL does not parse', () => {
    expect(maskUrl('http://user:pw@')).toBe(`http://${MASKED_SECRET}@`);
  });

  it('leaves a URL it cannot recognise alone', () => {
    expect(maskUrl('/relative/mcp')).toBe('/relative/mcp');
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

  it('masks URL-embedded credentials', () => {
    const masked = maskServerConfig(
      httpServer({ url: 'https://svc:ghp_x@host/mcp?access_token=abc' }),
    );
    expect(masked.transport).toBe('http');
    if (masked.transport !== 'http') throw new Error('unreachable');
    expect(masked.url).toBe(`https://${MASKED_SECRET}@host/mcp?access_token=${MASKED_SECRET}`);
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

describe('containsMaskedSecret / resolveMaskedUrl', () => {
  const storedUrl = 'https://svc:ghp_token@host/mcp';

  it('recognises the placeholder in both its spellings', () => {
    expect(containsMaskedSecret(`https://${MASKED_SECRET}@host/mcp`)).toBe(true);
    // The percent-encoded bullet survives a URL round trip inside a query value.
    expect(
      containsMaskedSecret(`https://host/mcp?token=${encodeURIComponent(MASKED_SECRET)}`),
    ).toBe(true);
    expect(containsMaskedSecret('https://user:real@host/mcp')).toBe(false);
    expect(containsMaskedSecret(undefined)).toBe(false);
    expect(containsMaskedSecret('')).toBe(false);
  });

  it('resolves an echoed masked URL to the stored value verbatim', () => {
    expect(resolveMaskedUrl(`https://${MASKED_SECRET}@host/mcp`, storedUrl)).toBe(storedUrl);
    expect(resolveMaskedUrl('https://new.example.com/mcp', storedUrl)).toBe(
      'https://new.example.com/mcp',
    );
  });

  it('returns undefined when the mask has nothing stored behind it', () => {
    // The caller must reject this instead of writing the literal mask.
    expect(resolveMaskedUrl(`https://${MASKED_SECRET}@host/mcp`, undefined)).toBeUndefined();
  });

  it('keeps a stored ${VAR} reference when resolving an echo', () => {
    expect(resolveMaskedUrl(`https://${MASKED_SECRET}@host/mcp`, '${MCP_URL}/mcp')).toBe(
      '${MCP_URL}/mcp',
    );
  });
});

describe('maskUrlInText', () => {
  it('masks a credential-bearing URL embedded in an error message', () => {
    const masked = maskUrlInText('fetch failed for https://svc:ghp_token@host/mcp (timeout)');
    expect(masked).not.toContain('ghp_token');
    expect(masked).toContain(`https://${MASKED_SECRET}@host/mcp (timeout)`);
  });

  it('masks secret query parameters embedded in text', () => {
    const masked = maskUrlInText('error at https://host/mcp?access_token=abc while polling');
    expect(masked).not.toContain('abc');
    expect(masked).toContain(`https://host/mcp?access_token=${MASKED_SECRET}`);
  });

  it('leaves text without URLs — and credential-free URLs — unchanged', () => {
    expect(maskUrlInText('spawn npx ENOENT')).toBe('spawn npx ENOENT');
    expect(maskUrlInText('https://example.com/mcp refused')).toBe(
      'https://example.com/mcp refused',
    );
  });
});
