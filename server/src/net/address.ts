import { BlockList, isIP } from "node:net";

/**
 * Addresses a server-side fetch of a URL taken from data must never reach: loopback, private,
 * link-local, shared, benchmarking, documentation, multicast and reserved ranges, and every IPv6
 * form that can embed an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo), since those are
 * routed to whatever IPv4 address they carry.
 */
// Separate lists: a single BlockList matches IPv4 queries against IPv4-mapped IPv6 rules.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped
  ["::", 96], // IPv4-compatible (deprecated)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, "ipv6");
}

/** True for any address a fetch of untrusted URLs must not connect to. Non-IPs count as blocked. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 0) {
    return true;
  }
  return family === 4 ? BLOCKED_V4.check(bare, "ipv4") : BLOCKED_V6.check(bare, "ipv6");
}

/**
 * True for a URL host that is, without any DNS lookup, known not to be public: a blocked IP
 * literal (in any notation the URL parser normalises), `localhost` or a name under it.
 */
export function isNonPublicHostLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(bare) !== 0) {
    return isPrivateAddress(bare);
  }
  return bare === "localhost" || bare.endsWith(".localhost");
}

/** Whether `host` matches the allow-list: exact names, or `.example.com` for its subdomains too. */
export function hostAllowed(host: string, allowed: Iterable<string>): boolean {
  const name = host.toLowerCase();
  for (const entry of allowed) {
    const rule = entry.toLowerCase();
    if (rule.startsWith(".") ? name === rule.slice(1) || name.endsWith(rule) : name === rule) {
      return true;
    }
  }
  return false;
}
