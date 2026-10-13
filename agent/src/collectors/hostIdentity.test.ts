import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cleanHostname, collectHostIdentity, ipsFromInterfaces, ipsFromProcNet, parseFibTrieLocal, parseProcRoute,
} from './hostIdentity.js';

// Trimmed capture of a Docker host (Jarvis): LAN on eno1, docker0 and
// three compose bridges.
const FIB_TRIE = `Main:
  +-- 0.0.0.0/0 3 0 4
     |-- 0.0.0.0
        /0 universe UNICAST
     +-- 127.0.0.0/8 2 0 2
        +-- 127.0.0.0/31 1 0 0
           |-- 127.0.0.0
              /8 host LOCAL
           |-- 127.0.0.1
              /32 host LOCAL
     +-- 172.16.0.0/13 4 0 8
        +-- 172.17.0.0/31 1 0 0
           |-- 172.17.0.0
              /16 link UNICAST
           |-- 172.17.0.1
              /32 host LOCAL
        +-- 172.18.0.0/31 1 0 0
           |-- 172.18.0.1
              /32 host LOCAL
     +-- 192.168.32.0/24 2 1 2
        |-- 192.168.32.0
           /24 link UNICAST
        +-- 192.168.32.192/26 2 0 2
           |-- 192.168.32.210
              /32 host LOCAL
           |-- 192.168.32.255
              /32 link BROADCAST
Local:
  +-- 192.168.32.0/24 2 1 2
     |-- 192.168.32.210
        /32 host LOCAL
`;

const ROUTE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eno1	00000000	0120A8C0	0003	0	0	1002	00000000	0	0	0
docker0	000011AC	00000000	0001	0	0	0	0000FFFF	0	0	0
br-356c86cbbbf0	000012AC	00000000	0001	0	0	0	0000FFFF	0	0	0
eno1	0020A8C0	00000000	0001	0	0	1002	00FFFFFF	0	0	0
`;

test('parseFibTrieLocal: keeps /32 host LOCAL leaves only, deduplicated', () => {
  assert.deepEqual(parseFibTrieLocal(FIB_TRIE).sort(), ['127.0.0.1', '172.17.0.1', '172.18.0.1', '192.168.32.210']);
});

test('parseProcRoute: skips the header and the default route', () => {
  const routes = parseProcRoute(ROUTE);
  assert.deepEqual(routes.map((r) => r.iface), ['docker0', 'br-356c86cbbbf0', 'eno1']);
});

test('ipsFromProcNet: LAN address only, bridges and loopback dropped', () => {
  assert.deepEqual(ipsFromProcNet(FIB_TRIE, ROUTE), ['192.168.32.210']);
});

test('ipsFromInterfaces: drops internal, IPv6, docker, veth, virbr and WSL adapters', () => {
  const v4 = (address: string, internal = false) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '', internal, cidr: null });
  const ips = ipsFromInterfaces({
    lo: [v4('127.0.0.1', true)],
    eth0: [v4('192.168.1.20'), { ...v4('fe80::1'), family: 'IPv6' as const, scopeid: 0 }],
    docker0: [v4('172.17.0.1')],
    'br-abc': [v4('172.18.0.1')],
    veth12: [v4('10.0.0.9')],
    virbr0: [v4('192.168.122.1')],
    'vEthernet (WSL)': [v4('172.30.0.1')],
    Ethernet: [v4('10.1.2.3')],
  });
  assert.deepEqual(ips, ['192.168.1.20', '10.1.2.3']);
});

test('cleanHostname: rejects blanks, whitespace and control characters', () => {
  assert.equal(cleanHostname('  deb13\n'), 'deb13');
  assert.equal(cleanHostname(''), null);
  assert.equal(cleanHostname('a b'), null);
  assert.equal(cleanHostname('x'.repeat(254)), null);
});

test('collectHostIdentity (docker): host /etc/hostname + host netns, never the container id', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gv-ident-'));
  mkdirSync(path.join(root, 'proc/1/net'), { recursive: true });
  mkdirSync(path.join(root, 'etc'));
  writeFileSync(path.join(root, 'proc/1/net/fib_trie'), FIB_TRIE);
  writeFileSync(path.join(root, 'proc/1/net/route'), ROUTE);
  writeFileSync(path.join(root, 'etc/hostname'), 'jarvis\n');
  const env = { HOST_PROC: path.join(root, 'proc'), HOST_ETC: path.join(root, 'etc') };
  assert.deepEqual(collectHostIdentity(true, env), { hostname: 'jarvis', ips: ['192.168.32.210'] });
  assert.equal(collectHostIdentity(true, { ...env, AGENT_HOSTNAME: 'override' }).hostname, 'override');
  // Nothing mounted: empty, not the container's own name and bridge IP.
  assert.deepEqual(collectHostIdentity(true, { HOST_PROC: '/nonexistent', HOST_ETC: '/nonexistent' }), { hostname: null, ips: [] });
});
