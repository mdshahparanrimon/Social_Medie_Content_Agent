import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp } from '../src/net/ipPolicy.js';

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e']) {
    assert.equal(isPublicIp(ip), true, ip);
  }
});

test('private, loopback, link-local, metadata and reserved IPv4 are blocked', () => {
  for (const ip of ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});

test('IPv6 loopback, unique-local, link-local, multicast and documentation ranges are blocked', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '2001:db8::1', '64:ff9b:1::1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});

test('IPv4-mapped and NAT64 IPv6 forms are judged by the IPv4 address inside', () => {
  assert.equal(isPublicIp('::ffff:127.0.0.1'), false);
  assert.equal(isPublicIp('::ffff:7f00:1'), false);
  assert.equal(isPublicIp('::ffff:169.254.169.254'), false);
  assert.equal(isPublicIp('64:ff9b::10.0.0.1'), false);
  assert.equal(isPublicIp('::ffff:8.8.8.8'), true);
});

test('malformed or non-IP strings are never public', () => {
  for (const v of ['', 'localhost', '1.2.3', '999.1.1.1', 'example.com', '0x7f.1', '2130706433']) assert.equal(isPublicIp(v), false, v);
});
