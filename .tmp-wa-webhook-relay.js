const http = require('http');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const allowed = url.pathname === '/api/whatsapp/webhook'
    && (req.method === 'GET' || req.method === 'POST');

  if (!allowed) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const proxy = http.request({
    hostname: '127.0.0.1',
    port: 5000,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: 'localhost:5000' },
  }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });

  proxy.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Webhook backend unavailable');
  });
  req.pipe(proxy);
});

server.listen(5051, '127.0.0.1', () => {
  console.log('WhatsApp-only relay listening on http://127.0.0.1:5051');
});
