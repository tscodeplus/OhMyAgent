// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the web_fetch tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import * as https from 'node:https';
import * as http from 'node:http';
import * as dns from 'node:dns';
import * as zlib from 'node:zlib';
import { URL } from 'node:url';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

export const webFetchToolCapability: ToolCapabilityDescriptor = {
  category: 'web',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: true,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

// ---------------------------------------------------------------------------
// Private IP detection helpers
// ---------------------------------------------------------------------------

/** Convert a dotted-quad IPv4 string to a 32-bit integer. */
function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** Common private / reserved IPv4 CIDR ranges. */
const PRIVATE_RANGES: ReadonlyArray<{ min: number; max: number }> = [
  { min: ipToInt('10.0.0.0'), max: ipToInt('10.255.255.255') },
  { min: ipToInt('127.0.0.0'), max: ipToInt('127.255.255.255') },
  { min: ipToInt('169.254.0.0'), max: ipToInt('169.254.255.255') },
  { min: ipToInt('172.16.0.0'), max: ipToInt('172.31.255.255') },
  { min: ipToInt('192.168.0.0'), max: ipToInt('192.168.255.255') },
];

/** Returns true when `ip` falls in a private/reserved range. */
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
  return PRIVATE_RANGES.some((r) => int >= r.min && int <= r.max);
}

/** Returns true when the hostname is a well-known internal name. */
function isInternalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return lower === 'localhost' || lower.endsWith('.local') || isPrivateIP(lower);
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Promisified dns.lookup. */
function dnsLookup(hostname: string): Promise<ResolvedAddress> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family: family as 4 | 6 });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP(S) GET helper
// ---------------------------------------------------------------------------

interface FetchResult {
  data: string;
  contentType: string;
}

function decodeResponseBody(body: Buffer, encodingHeader: string | string[] | undefined): string {
  const encoding = Array.isArray(encodingHeader)
    ? encodingHeader.join(',').toLowerCase()
    : String(encodingHeader ?? '').toLowerCase();

  if (encoding.includes('br')) {
    return zlib.brotliDecompressSync(body).toString('utf-8');
  }
  if (encoding.includes('gzip')) {
    return zlib.gunzipSync(body).toString('utf-8');
  }
  if (encoding.includes('deflate')) {
    return zlib.inflateSync(body).toString('utf-8');
  }
  return body.toString('utf-8');
}

/**
 * Perform an HTTP GET request using Node.js built-in modules.
 * Returns the response body as a string along with the Content-Type header.
 */
function httpGet(targetUrl: string, timeoutMs: number, resolvedAddress: ResolvedAddress): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const lookup: LookupFunction = (_hostname, opts, cb) => {
      if (typeof opts === 'object' && opts?.all) {
        cb(null, [resolvedAddress]);
        return;
      }
      cb(null, resolvedAddress.address, resolvedAddress.family);
    };
    const req = mod.get(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        timeout: timeoutMs,
        lookup,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.208 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        servername: net.isIP(parsedUrl.hostname.replace(/^\[|\]$/g, '')) ? undefined : parsedUrl.hostname,
      },
      (res) => {
        const contentType = res.headers['content-type'] ?? 'application/octet-stream';
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = decodeResponseBody(Buffer.concat(chunks), res.headers['content-encoding']);
          resolve({ data, contentType: contentType.split(';')[0]!.trim() });
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ---------------------------------------------------------------------------
// HTML text extraction
// ---------------------------------------------------------------------------

/** Strip HTML tags and decode common entities, returning plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// ToolDefinition factory
// ---------------------------------------------------------------------------

export function createWebFetchToolDefinition(): ToolDefinition {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description: 'Fetch a URL and extract its content. Supports HTML and general file downloads.',
    category: 'web',
    parametersSchema: Type.Object({
      url: Type.String({ description: 'The URL to fetch' }),
      prompt: Type.Optional(Type.String({ description: 'Optional context prompt to prepend to the result' })),
    }),
    capability: webFetchToolCapability,
    execute: async (args: { url: string; prompt?: string }, _ctx: ToolExecutionContext) => {
      try {
        // ---------- URL parsing & protocol validation ----------

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(args.url);
        } catch {
          return errorResult(`Invalid URL: ${args.url}`);
        }

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return errorResult(
            `Unsupported protocol: ${parsedUrl.protocol}. Only http: and https: are allowed.`,
          );
        }

        const hostname = parsedUrl.hostname;

        // ---------- Internal hostname check ----------

        if (isInternalHostname(hostname)) {
          return errorResult(`Access denied: cannot fetch from internal hostname "${hostname}".`);
        }

        // ---------- DNS resolution & private IP check ----------

        let resolvedAddress: ResolvedAddress;
        try {
          resolvedAddress = await dnsLookup(hostname);
        } catch {
          return errorResult(
            `Access denied: could not resolve DNS for "${hostname}". Safety check failed.`,
          );
        }

        if (isPrivateIP(resolvedAddress.address)) {
          return errorResult(
            `Access denied: "${hostname}" resolves to private IP "${resolvedAddress.address}".`,
          );
        }

        // ---------- HTTP GET ----------

        const { data, contentType } = await httpGet(args.url, 30_000, resolvedAddress);

        // ---------- Response handling ----------

        let content: string;
        if (contentType.startsWith('text/html')) {
          content = stripHtml(data);
        } else {
          content = `[File: ${contentType}, size: ${Buffer.byteLength(data)} bytes]`;
        }

        if (args.prompt) {
          content = `[User prompt: ${args.prompt}]\n\n${content}`;
        }

        return textResult(content);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to fetch URL: ${message}`);
      }
    },
  };
}
