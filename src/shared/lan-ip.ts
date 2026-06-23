/**
 * LAN address detection utility.
 *
 * Used by QR code generation to produce URLs that are reachable
 * from a mobile device on the same local network.
 */

import os from 'node:os';

/**
 * Get the best LAN-accessible URL for the server.
 *
 * Enumerates network interfaces, returns the first non-internal IPv4
 * address formatted as an HTTP URL with the given port.
 * Falls back to localhost if no LAN IP is found.
 *
 * @param port - The server port number.
 * @param protocol - 'http' or 'https' (default: 'http').
 * @returns A full base URL string, e.g. "http://192.168.1.5:9191".
 */
export function getLanAddress(
  port: number,
  protocol: 'http' | 'https' = 'http',
): string {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    const ifaces = interfaces[name];
    if (!ifaces) continue;
    for (const iface of ifaces) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return `${protocol}://${iface.address}:${port}`;
      }
    }
  }

  // Fallback: no LAN IP found (e.g. offline, Docker-only, or all interfaces
  // are internal). localhost works for same-device scanning (Electron desktop).
  return `${protocol}://127.0.0.1:${port}`;
}

/**
 * Parse the port from a listen address string like "0.0.0.0:9191" or "127.0.0.1:8080".
 *
 * @param listenAddr - Address string in "host:port" format.
 * @param fallbackPort - Port to use if parsing fails.
 * @returns The parsed port number.
 */
export function parsePort(listenAddr: string, fallbackPort: number): number {
  const match = listenAddr.match(/:(\d+)$/);
  if (match) {
    const port = parseInt(match[1], 10);
    if (Number.isFinite(port) && port > 0) return port;
  }
  return fallbackPort;
}
