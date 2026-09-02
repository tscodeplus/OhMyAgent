/**
 * Tests for the shared SSRF address classifier behind web_fetch and
 * remote_trigger.
 *
 * The cases that matter most are the ones the two deleted per-file copies got
 * wrong: 0.0.0.0/8 (loops back to this host on Linux), 100.64.0.0/10 (CGNAT,
 * i.e. Tailscale and carrier NAT), and IPv6 literals that embed an IPv4
 * address in hex — `::ffff:7f00:1` is 127.0.0.1, and the old string-prefix
 * checks only recognised the dotted-quad spelling.
 */

import { describe, it, expect } from 'vitest';
import { isBlockedAddress, isInternalHostname, parseIPv4, parseIPv6 } from '../../src/shared/ssrf.js';

describe('isBlockedAddress — IPv4', () => {
  it.each([
    '0.0.0.0',
    '0.42.42.42',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.5',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.255.255',
    '192.169.0.1',
    '198.17.255.255',
    '223.255.255.255',
  ])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('blocks 100.100.100.100, the metadata address some CN clouds use', () => {
    expect(isBlockedAddress('100.100.100.100')).toBe(true);
  });
});

describe('isBlockedAddress — IPv6', () => {
  it.each(['::', '::1', '100::1', '2001::1', '2001:db8::1', 'fc00::1', 'fd12:3456::78', 'fe80::1', 'ff02::1'])(
    'blocks %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '2400:3200::1', '2002:0102:0304::'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each([
    ['::ffff:127.0.0.1', 'v4-mapped, dotted'],
    ['::ffff:7f00:1', 'v4-mapped, hex (the bypass)'],
    ['::ffff:0a00:0001', 'v4-mapped 10.0.0.1'],
    ['::7f00:1', 'deprecated v4-compatible'],
    ['2002:7f00:0001::', '6to4 wrapping 127.0.0.1'],
    ['64:ff9b::7f00:1', 'NAT64 well-known prefix wrapping 127.0.0.1'],
    ['64:ff9b::c0a8:1', 'NAT64 wrapping 192.168.0.1'],
  ])('blocks %s — %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it('does not treat every ::ffff: address as internal', () => {
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('::ffff:1.1.1.1')).toBe(false);
  });

  it('accepts bracketed and zone-scoped forms', () => {
    expect(isBlockedAddress('[::1]')).toBe(true);
    expect(isBlockedAddress('[fe80::1]')).toBe(true);
    expect(isBlockedAddress('fe80::1%wlan0')).toBe(true);
  });
});

describe('isBlockedAddress — non-address input', () => {
  it.each(['example.com', '', '   ', 'not-an-ip', '300.1.1.1', '1.2.3', '1.2.3.4.5'])(
    'is not classified as an address: %s',
    (value) => {
      expect(isBlockedAddress(value)).toBe(false);
    },
  );
});

describe('isInternalHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'localhost.', 'api.localhost', 'printer.local', '127.0.0.1', '192.168.4.20', '100.64.5.6', '[::1]'])(
    'treats %s as local',
    (hostname) => {
      expect(isInternalHostname(hostname)).toBe(true);
    },
  );

  it.each(['example.com', 'api.github.com', '8.8.8.8', 'subdomain.corp.internal', 'myserver'])(
    'treats %s as external',
    (hostname) => {
      expect(isInternalHostname(hostname)).toBe(false);
    },
  );
});

describe('parseIPv4 / parseIPv6', () => {
  it('parses dotted quads and rejects everything else', () => {
    expect(parseIPv4('1.2.3.4')).toBe(0x01020304);
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
    expect(parseIPv4('0255.1.1.1')).toBeNull();
    expect(parseIPv4('1.2.3.4.5')).toBeNull();
    expect(parseIPv4('::1')).toBeNull();
  });

  it('expands IPv6 with and without compression', () => {
    expect(parseIPv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::')).toEqual(new Array(8).fill(0));
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects malformed IPv6, including over-long compression', () => {
    expect(parseIPv6('1:2:3:4:5:6:7')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('::1::2')).toBeNull();
    expect(parseIPv6('gooo::1')).toBeNull();
    expect(parseIPv6('12345::1')).toBeNull();
    expect(parseIPv6('example.com')).toBeNull();
  });
});
