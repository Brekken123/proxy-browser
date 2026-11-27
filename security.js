/**
 * security.js — blocks requests to internal / private network addresses (SSRF protection).
 * Every target hostname is resolved via DNS and ALL returned addresses are checked.
 */
const dns = require('dns').promises;
const net = require('net');

/** Convert dotted IPv4 into a 32-bit unsigned integer. */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

/** IPv4 CIDR ranges that must never be reachable through the proxy. */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(({ base, mask }) => (n & mask) === (base & mask));
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return /^(fc|fd)/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true; // unknown format → block
}

/**
 * Throws an Error if the URL is not allowed (bad protocol, localhost, private IP).
 * @param {string} rawUrl
 */
async function assertSafeUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS are supported');

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Access to internal hosts is blocked');
  }

  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length) throw new Error('Host could not be resolved');
  if (addresses.some(isPrivateIp)) throw new Error('Access to private / internal IP addresses is blocked');
  return url;
}

module.exports = { assertSafeUrl, isPrivateIp };
