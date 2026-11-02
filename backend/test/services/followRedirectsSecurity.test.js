import { test, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { http } = require('follow-redirects');

// GHSA-mrwp-f3q8-3g9p: custom credentials must not cross origins even
// when the sensitiveHeaders array comes from another JavaScript realm.
test.each(['same realm', 'cross realm'])('strips custom credentials on redirects (%s)', async (realm) => {
  let received;
  const target = createServer((req, res) => {
    received = req.headers;
    res.end('ok');
  });
  const source = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/` });
    res.end();
  });
  const listen = (server) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = (server) => new Promise((resolve) => server.close(resolve));
  try {
    await listen(target);
    await listen(source);
    const sensitiveHeaders = realm === 'cross realm'
      ? runInNewContext("['X-API-Key']")
      : ['X-API-Key'];
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${source.address().port}/`, {
        headers: { 'X-API-Key': 'local-test-only', 'X-Harmless': 'preserved' },
        sensitiveHeaders,
      }, (res) => {
        res.on('error', reject);
        res.on('end', resolve);
        res.resume();
      });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('Redirect test timed out')));
    });
    expect(received).toBeDefined();
    expect(received['x-api-key']).toBeUndefined();
    expect(received['x-harmless']).toBe('preserved');
  } finally {
    await close(source);
    await close(target);
  }
});
