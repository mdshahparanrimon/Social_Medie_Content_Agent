import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AppError } from '../errors.js';
import { isPublicIp } from './ipPolicy.js';

// An HTTP client for fetching links that users or AI clients supply. It never connects to a non-public address:
//  - the scheme is https (http only through the test overrides) and URLs may not carry credentials;
//  - the hostname is resolved here, every resolved address (IPv4 and IPv6) must be public, and the connection is
//    made to that exact address ("pinned"), so a second DNS lookup can't rebind the name to an internal address;
//  - redirects are followed by hand, and every hop goes through the same checks (and an optional host allowlist);
//  - one connection per request (no keep-alive agent), so a pinned address is never reused for another host;
//  - a total timeout and an AbortSignal bound the whole request, and bodies are streamed, never buffered here.

export const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export function parseSafeUrl(value, { allowHttp = false, allowedHosts } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new AppError('INVALID_URL', 'That is not a valid link.');
  }
  const schemeOk = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (!schemeOk) throw new AppError('INVALID_URL', 'Links must start with https://');
  if (url.username || url.password) throw new AppError('INVALID_URL', 'Links with a user name or password are not accepted.');
  if (!url.hostname) throw new AppError('INVALID_URL', 'That link has no host name.');
  const host = url.hostname.toLowerCase();
  if (allowedHosts && !allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new AppError('HOST_NOT_ALLOWED', 'That link points to a host this feature does not fetch from.');
  }
  return url;
}

// Resolves a host to addresses and throws unless every one of them is public.
export async function resolvePublic(hostname, { resolve = defaultResolve, exemptHosts = [] } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await resolve(host);
  if (!addresses.length) throw new AppError('DNS_FAILED', 'Could not find that link\'s server.');
  if (!exemptHosts.includes(host.toLowerCase())) {
    for (const { address } of addresses) {
      if (!isPublicIp(address)) throw new AppError('BLOCKED_ADDRESS', 'That link points to a non-public address, so it was not fetched.');
    }
  }
  return addresses;
}

async function defaultResolve(host) {
  try {
    return await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new AppError('DNS_FAILED', 'Could not find that link\'s server.', { details: { cause: err.code } });
  }
}

function requestOnce(url, address, { headers, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        host: address.address,
        family: address.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        servername: net.isIP(url.hostname) ? undefined : url.hostname, // TLS SNI + certificate check use the name, not the pinned IP
        headers: { Host: url.host, 'User-Agent': 'ContentAgent/1.0', Accept: '*/*', ...headers },
        signal,
        timeout: timeoutMs,
      },
      resolve,
    );
    req.on('timeout', () => {
      req.timedOut = true;
      req.destroy(new AppError('TIMEOUT', 'The link took too long to respond.', { status: 408 }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET `url` safely. Resolves to { response (IncomingMessage), finalUrl }. The caller must consume or destroy the body.
 * options: timeoutMs (per request, idle), totalTimeoutMs (whole call incl. redirects), maxRedirects, headers (not
 * forwarded across hosts), allowedHosts, signal, and `testing` { allowHttp, exemptHosts, resolve } for unit tests only.
 */
export async function safeGet(input, options = {}) {
  const { timeoutMs = 15_000, totalTimeoutMs = 60_000, maxRedirects = 5, headers = {}, allowedHosts, signal, testing } = options;
  if (testing && process.env.NODE_ENV !== 'test') throw new Error('safeGet testing overrides are only available when NODE_ENV=test.');
  const { allowHttp = false, exemptHosts = [], resolve } = testing || {};

  const total = AbortSignal.timeout(totalTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, total]) : total;
  const seen = new Set();
  let url = parseSafeUrl(input, { allowHttp, allowedHosts });
  let sendHeaders = headers;
  const firstHost = url.host;

  try {
    for (let hop = 0; ; hop++) {
      const key = url.href;
      if (seen.has(key)) throw new AppError('REDIRECT_LOOP', 'That link redirects in a loop.');
      seen.add(key);

      const addresses = await resolvePublic(url.hostname, { resolve, exemptHosts });
      let response;
      let lastErr;
      // Try each validated address in order (e.g. IPv6 then IPv4) but never anything that was not validated.
      for (const address of addresses) {
        try {
          response = await requestOnce(url, address, { headers: url.host === firstHost ? sendHeaders : {}, timeoutMs, signal: combined });
          break;
        } catch (err) {
          lastErr = err;
          if (combined.aborted || err instanceof AppError) break;
        }
      }
      if (!response) throw lastErr;

      if (REDIRECT_STATUS.has(response.statusCode)) {
        response.resume();
        const location = response.headers.location;
        if (!location) throw new AppError('INACCESSIBLE', 'That link redirected nowhere.', { status: 502 });
        if (hop >= maxRedirects) throw new AppError('TOO_MANY_REDIRECTS', 'That link redirected too many times.');
        url = parseSafeUrl(new URL(location, url).href, { allowHttp, allowedHosts });
        if (url.host !== firstHost) sendHeaders = {};
        continue;
      }
      return { response, finalUrl: url, signal: combined, totalTimedOut: () => total.aborted };
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (total.aborted || err.name === 'TimeoutError') throw new AppError('TIMEOUT', 'The link took too long to download.', { status: 408 });
    if (signal?.aborted) throw new AppError('CANCELLED', 'The download was cancelled.', { status: 499 });
    // Node's low-level errors can include the address and path; keep only the code.
    throw new AppError('UNREACHABLE', 'Could not reach that link.', { status: 502, details: { cause: err.code || err.name } });
  }
}
