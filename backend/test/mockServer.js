import http from 'node:http';

// A throwaway HTTP server on 127.0.0.1 for tests. Returns { port, url(path), close, hits }.
export async function startServer(handler) {
  const hits = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    handler(req, res);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    hits,
    url: (p = '/') => `http://mock.test:${port}${p}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(resolve);
      }),
  };
}

// Test overrides for safeGet/withDownload: plain http allowed, "mock.test" may resolve to loopback, everything else is checked.
export const testing = (extra = {}) => ({
  allowHttp: true,
  exemptHosts: ['mock.test'],
  resolve: async (host) => {
    if (host === 'mock.test') return [{ address: '127.0.0.1', family: 4 }];
    if (host === 'internal.test') return [{ address: '10.0.0.5', family: 4 }];
    if (host === 'mixed.test') return [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }];
    if (host === 'v6.test') return [{ address: '::1', family: 6 }];
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  },
  ...extra,
});
