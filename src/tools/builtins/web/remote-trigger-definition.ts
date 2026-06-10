// ---------------------------------------------------------------------------
// v4 ToolDefinition for remote_trigger — trigger configured HTTP endpoints
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';
import * as dns from 'node:dns';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

export const remoteTriggerCapability: ToolCapabilityDescriptor = {
  category: 'web',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: true,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'high_risk',
};

const RemoteTriggerParams = Type.Object({
  targetId: Type.String({ description: 'ID of the configured remote trigger target' }),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'JSON payload to send (max 64KB)' })),
});

interface RemoteTriggerArgs {
  targetId: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/** Convert dotted-quad IPv4 string to 32-bit integer. */
function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

const PRIVATE_RANGES: ReadonlyArray<{ min: number; max: number }> = [
  { min: ipToInt('10.0.0.0'), max: ipToInt('10.255.255.255') },
  { min: ipToInt('127.0.0.0'), max: ipToInt('127.255.255.255') },
  { min: ipToInt('169.254.0.0'), max: ipToInt('169.254.255.255') },
  { min: ipToInt('172.16.0.0'), max: ipToInt('172.31.255.255') },
  { min: ipToInt('192.168.0.0'), max: ipToInt('192.168.255.255') },
];

function isPrivateIP(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1'
      || normalized.startsWith('fe80:')
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized === '::'
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.')
      || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return true;
  if (normalized.includes(':')) return false;
  const int = ipToInt(normalized);
  return PRIVATE_RANGES.some(r => int >= r.min && int <= r.max);
}

function isInternalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return lower === 'localhost' || lower.endsWith('.local') || isPrivateIP(lower);
}

interface ResolvedAddress { address: string; family: 4 | 6 }

function dnsLookup(hostname: string): Promise<ResolvedAddress> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family: family as 4 | 6 });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP request helper (no redirect following)
// ---------------------------------------------------------------------------

function httpRequest(
  urlStr: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  resolvedAddress?: ResolvedAddress,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = urlStr.startsWith('https:') ? https : http;
    const parsedUrl = new URL(urlStr);
    const lookup: LookupFunction | undefined = resolvedAddress
      ? ((_hostname, _opts, cb) => {
          cb(null, resolvedAddress.address, resolvedAddress.family);
        })
      : undefined;
    const reqHeaders: Record<string, string> = {
      ...headers,
      'Content-Type': 'application/json',
    };
    if (body) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body).toString();
    }

    const req = mod.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method,
        timeout: timeoutMs,
        headers: reqHeaders,
        lookup,
        servername: net.isIP(parsedUrl.hostname.replace(/^\[|\]$/g, '')) ? undefined : parsedUrl.hostname,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createRemoteTriggerToolDefinition(): ToolDefinition {
  return {
    name: 'remote_trigger',
    label: 'Remote Trigger',
    description: 'Send POST/PUT to a pre-configured remote trigger target.',
    category: 'web',
    parametersSchema: RemoteTriggerParams,
    capability: remoteTriggerCapability,
    execute: async (args: RemoteTriggerArgs, ctx: ToolExecutionContext) => {
      const config = ctx.services.config;

      // -----------------------------------------------------------------------
      // 1. Look up the target in the configuration
      // -----------------------------------------------------------------------
      const targets = config.remoteTriggers?.targets ?? [];
      const target = targets.find(t => t.id === args.targetId);

      if (!target) {
        const knownIds = targets.map(t => `"${t.id}"`).join(', ') || '(none configured)';
        return errorResult(
          `Remote trigger target "${args.targetId}" not found in configuration. ` +
          `Known targets: ${knownIds}`,
        );
      }

      // -----------------------------------------------------------------------
      // 2. Validate payload size (max 64KB)
      // -----------------------------------------------------------------------
      let body: string | undefined;
      if (args.payload !== undefined) {
        body = JSON.stringify(args.payload);
        const byteLen = Buffer.byteLength(body, 'utf-8');
        if (byteLen > 64 * 1024) {
          return errorResult(`Payload exceeds 64KB (${byteLen} bytes). Reduce the payload size.`);
        }
      }

      // -----------------------------------------------------------------------
      // 3. URL validation — must be https (unless localhost) and match the configured URL exactly
      // -----------------------------------------------------------------------
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(target.url);
      } catch {
        return errorResult(`Invalid URL in configuration for target "${args.targetId}": ${target.url}`);
      }

      // Only POST and PUT are allowed
      const allowedMethods = new Set(['POST', 'PUT']);
      if (!allowedMethods.has(target.method)) {
        return errorResult(`Unsupported method "${target.method}". Only POST and PUT are allowed.`);
      }

      // Enforce https unless the target is localhost
      const isLocalhost = isInternalHostname(parsedUrl.hostname);
      if (parsedUrl.protocol !== 'https:' && !isLocalhost) {
        return errorResult(`Only https: URLs are allowed. Target URL: ${target.url}`);
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        return errorResult(`Unsupported protocol: ${parsedUrl.protocol}`);
      }

      // -----------------------------------------------------------------------
      // 4. DNS resolution and private IP check (unless localhost)
      // -----------------------------------------------------------------------
      let resolved: ResolvedAddress | undefined;
      if (!isLocalhost) {
        try {
          resolved = await dnsLookup(parsedUrl.hostname);
          if (isPrivateIP(resolved.address)) {
            return errorResult(
              `Target "${args.targetId}" resolves to private IP "${resolved.address}". Blocked for security.`,
            );
          }
        } catch {
          return errorResult(`Could not resolve DNS for "${parsedUrl.hostname}".`);
        }
      }

      // -----------------------------------------------------------------------
      // 5. Send the request (headers from config only, never from model)
      // -----------------------------------------------------------------------
      try {
        const { status, body: respBody } = await httpRequest(
          target.url,
          target.method,
          target.headers ?? {},
          body,
          30_000,
          resolved,
        );

        // Don't echo headers in output — only status and body
        const snippet = respBody.length > 500 ? respBody.slice(0, 500) + '...' : respBody;
        return textResult(
          `Triggered "${target.name}" (${target.id}).\n` +
          `Method: ${target.method}\n` +
          `URL: ${target.url}\n` +
          `Status: ${status}\n` +
          `Response: ${snippet}`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Request to "${target.name}" failed: ${message}`);
      }
    },
  };
}
