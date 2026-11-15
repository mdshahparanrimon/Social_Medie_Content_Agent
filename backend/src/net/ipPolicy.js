import net from 'node:net';

// Which IP addresses the server may connect to when fetching a user-supplied link: public unicast only.
// Everything else (loopback, private, link-local, CGNAT, multicast, reserved, cloud metadata) is blocked.

const blocked = new net.BlockList();
const v4 = (net_, prefix) => blocked.addSubnet(net_, prefix, 'ipv4');
const v6 = (net_, prefix) => blocked.addSubnet(net_, prefix, 'ipv6');

[
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes the 169.254.169.254 cloud metadata address
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay (deprecated)
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
].forEach(([address, prefix]) => v4(address, prefix));

[
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address we would have to inspect)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
].forEach(([address, prefix]) => v6(address, prefix));

// Cloud metadata endpoints that sit outside the ranges above.
blocked.addAddress('fd00:ec2::254', 'ipv6'); // AWS (also inside fc00::/7, kept explicit)
blocked.addAddress('100.100.100.200', 'ipv4'); // Alibaba (also inside CGNAT)

// "::ffff:a.b.c.d" and the NAT64 prefix "64:ff9b::a.b.c.d" carry an IPv4 address; judge that one instead.
function embeddedIPv4(address) {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPublicIp(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6) {
    const inner = embeddedIPv4(address);
    if (inner) return isPublicIp(inner);
  }
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
