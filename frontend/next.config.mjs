// The browser only talks to this app's own domain: /api is forwarded to the backend.
// That keeps the login cookie first-party (no third-party cookies, no CORS).
const API_TARGET = (process.env.API_PROXY_TARGET || 'http://127.0.0.1:4000').replace(/\/+$/, '');

export default {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_TARGET}/api/:path*` }];
  },
};
