// The browser only talks to this app's own domain: /api is forwarded to the backend.
// That keeps the login cookie first-party (no third-party cookies, no CORS).
const API_TARGET = (process.env.API_PROXY_TARGET || 'http://127.0.0.1:4000').replace(/\/+$/, '');

export default {
  // AI calls (write + self-review + revisions, rate-limit retries) often take longer than the 30 s default.
  experimental: { proxyTimeout: 5 * 60_000 },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_TARGET}/api/:path*` }];
  },
};
