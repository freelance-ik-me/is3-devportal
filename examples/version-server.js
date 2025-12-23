#!/usr/bin/env node
const http = require('http');
const { URL } = require('url');

// Simple server to return plain-text versions per environment.
// Endpoints:
//   /conso/version -> 1.0.0
//   /int/version   -> 1.1.0
//   /pre/version   -> 1.2.0
//   /pro/version   -> 1.3.0
// You can override versions via env vars:
//   CONSO_VERSION, INT_VERSION, PRE_VERSION, PRO_VERSION

const versions = {
  conso: process.env.CONSO_VERSION || '1.0.0',
  int: process.env.INT_VERSION || '1.1.0',
  pre: process.env.PRE_VERSION || '1.2.0',
  pro: process.env.PRO_VERSION || '1.3.0',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.toLowerCase();

  // Simple CORS for browser calls
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (path === '/conso/version') return ok(res, versions.conso);
  if (path === '/int/version') return ok(res, versions.int);
  if (path === '/pre/version') return ok(res, versions.pre);
  if (path === '/pro/version') return ok(res, versions.pro);

  res.statusCode = 404;
  res.end('not found');
});

function ok(res, body) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end(body);
}

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`Version dummy server listening on ${port}`);
  console.log('Endpoints:');
  console.log(`  http://localhost:${port}/conso/version -> ${versions.conso}`);
  console.log(`  http://localhost:${port}/int/version   -> ${versions.int}`);
  console.log(`  http://localhost:${port}/pre/version   -> ${versions.pre}`);
  console.log(`  http://localhost:${port}/pro/version   -> ${versions.pro}`);
});
