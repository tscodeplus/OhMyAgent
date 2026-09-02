// ---------------------------------------------------------------------------
// SSRF guard — one address classifier for every outbound request
// ---------------------------------------------------------------------------
//
// web_fetch and remote_trigger each carried a hand-rolled copy of this check,
// and copies drift: both were missing 0.0.0.0/8 (which connects to *this host*
// on Linux), 100.64.0.0/10 (CGNAT — the space Tailscale and most mobile
// carriers allocate) and the rest of the special-purpose registry, and both
// decided "IPv6 ⇒ public" from a string prefix, so `::ffff:7f00:1` (= 127.0.0.1
// written in hex), 6to4 `2002:7f00:1::` and NAT64 `64:ff9b::7f00:1` slipped
// through while the dotted-quad spellings were blocked.
//
// Here addresses are parsed into numbers and compared numerically, and every
// IPv6 form that embeds an IPv4 address is unwrapped before classification.

/** An address that must never be reached from an agent-initiated request. */
export function isBlockedAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;

  const v4 = parseIPv4(normalized);
  if (v4 !== null) return isBlockedIPv4(v4);

  const groups = parseIPv6(normalized);
  if (!groups) return false;

  const embedded = embeddedIPv4(groups);
  if (embedded !== null) return isBlockedIPv4(embedded);

  return IPv6_BLOCKED.some(({ base, mask }) => matchesIPv6Mask(groups, base, mask));
}

/**
 * True for hostnames that name the local network rather than the public
 * internet: `localhost`, `*.localhost`, `*.local`, and any literal address in
 * a private/reserved range. Callers use it to relax *transport* policy
 * (plaintext http to a LAN target configured by the operator); it is not an
 * access grant — access is decided by isBlockedAddress on the resolved address.
 */
export function isInternalHostname(hostname: string): boolean {
  const lower = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    return true;
  }
  return isBlockedAddress(lower);
}

// ---------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------

/** IPv4 special-purpose ranges (RFC 6890) plus the classic private space. */
const IPv4_BLOCKED_CIDRS = [
  '0.0.0.0/8', // this host on this network
  '10.0.0.0/8', // private
  '100.64.0.0/10', // CGNAT / shared second address space
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local (incl. cloud metadata endpoints)
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved (incl. 255.255.255.255)
];

const IPv4_BLOCKED: ReadonlyArray<{ base: number; mask: number }> = IPv4_BLOCKED_CIDRS.map(
  (cidr) => {
    const [address, bits] = cidr.split('/');
    const prefix = Number(bits);
    const base = parseIPv4(address!);
    if (base === null || !Number.isInteger(prefix)) {
      throw new Error(`Invalid IPv4 CIDR in SSRF table: ${cidr}`);
    }
    return { base, mask: maskIPv4(prefix) };
  },
);

/** IPv6 ranges with no route to a public service. */
const IPv6_BLOCKED_PREFIXES: ReadonlyArray<{ address: string; bits: number }> = [
  { address: '::', bits: 128 }, // unspecified
  { address: '::1', bits: 128 }, // loopback
  { address: '100::', bits: 64 }, // discard-only
  { address: '2001::', bits: 32 }, // Teredo (tunnels an embedded v4 address)
  { address: '2001:db8::', bits: 32 }, // documentation
  { address: 'fc00::', bits: 7 }, // unique-local
  { address: 'fe80::', bits: 10 }, // link-local
  { address: 'ff00::', bits: 8 }, // multicast
];

const IPv6_BLOCKED = IPv6_BLOCKED_PREFIXES.map(({ address, bits }) => ({
  base: ipv6GroupsOrThrow(address),
  mask: maskIPv6(bits),
}));

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function normalizeAddress(address: string): string | null {
  const trimmed = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!trimmed) return null;
  // Strip an IPv6 zone id (`fe80::1%wlan0`) — it is not part of the address.
  const percent = trimmed.indexOf('%');
  return percent === -1 ? trimmed : trimmed.slice(0, percent);
}

/** Dotted quad → unsigned 32-bit int. Null for anything that is not one. */
export function parseIPv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let int = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    int = int * 256 + octet;
  }
  return int >>> 0;
}

function isBlockedIPv4(int: number): boolean {
  return IPv4_BLOCKED.some(({ base, mask }) => (int & mask) >>> 0 === (base & mask) >>> 0);
}

function maskIPv4(bits: number): number {
  if (bits <= 0) return 0;
  if (bits >= 32) return 0xffffffff;
  return (0xffffffff << (32 - bits)) >>> 0;
}

/**
 * IPv6 text → 8 groups of 16 bits, honouring `::` compression and a trailing
 * embedded IPv4 (`::ffff:127.0.0.1`). Null when the text is not IPv6.
 */
export function parseIPv6(address: string): number[] | null {
  if (!address.includes(':')) return null;

  const compression = address.indexOf('::');
  const head = compression === -1 ? address : address.slice(0, compression);
  const tail = compression === -1 ? null : address.slice(compression + 2);

  const expand = (text: string): number[] | null => {
    if (!text) return [];
    const groups: number[] = [];
    for (const segment of text.split(':')) {
      if (segment === '') return null;
      if (segment.includes('.')) {
        const v4 = parseIPv4(segment);
        if (v4 === null) return null;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
      groups.push(parseInt(segment, 16));
    }
    return groups;
  };

  const left = expand(head);
  if (!left) return null;

  if (tail === null) {
    return left.length === 8 ? left : null;
  }

  const right = expand(tail);
  if (!right) return null;
  const zeros = 8 - left.length - right.length;
  if (zeros < 1) return null;
  return [...left, ...new Array<number>(zeros).fill(0), ...right];
}

function ipv6GroupsOrThrow(address: string): number[] {
  const groups = parseIPv6(address);
  if (!groups) throw new Error(`Invalid IPv6 literal in SSRF table: ${address}`);
  return groups;
}

/** Per-group bit masks for a prefix length, e.g. /10 → [0xfc00, 0, ...]. */
function maskIPv6(bits: number): number[] {
  return Array.from({ length: 8 }, (_, i) => {
    const remaining = bits - i * 16;
    if (remaining <= 0) return 0;
    if (remaining >= 16) return 0xffff;
    return (0xffff << (16 - remaining)) & 0xffff;
  });
}

function matchesIPv6Mask(groups: number[], base: number[], mask: number[]): boolean {
  return groups.every((group, i) => (group & mask[i]!) === (base[i]! & mask[i]!));
}

/**
 * The IPv4 address carried inside an IPv6 literal, if any: v4-mapped
 * (`::ffff:a.b.c.d`), the deprecated v4-compatible form (`::a.b.c.d`), 6to4
 * (`2002:a.b.c.d::`) and the NAT64 well-known prefix (`64:ff9b::a.b.c.d`).
 * Without this, `::ffff:7f00:1` is loopback wearing hex digits.
 */
function embeddedIPv4(groups: number[]): number | null {
  const highZero = [0, 1, 2, 3, 4].every((i) => groups[i] === 0);
  const low32 = ((groups[6]! << 16) | groups[7]!) >>> 0;

  if (highZero && (groups[5] === 0xffff || groups[5] === 0) && low32 !== 0) {
    return low32;
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && [2, 3, 4, 5].every((i) => groups[i] === 0)) {
    return low32;
  }
  if (groups[0] === 0x2002) {
    return ((groups[1]! << 16) | groups[2]!) >>> 0;
  }
  return null;
}
