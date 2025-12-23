#!/usr/bin/env node
const http = require('http');
const { URL } = require('url');

// Simple server to return plain-text versions per environment.
// Endpoints:
//   /local/version -> 1.0.0
//   /conso/version -> 1.0.0
//   /int/version   -> 1.1.0
//   /pre/version   -> 1.2.0
//   /pro/version   -> 1.3.0
// You can override versions via env vars:
//   LOCAL_VERSION, CONSO_VERSION, INT_VERSION, PRE_VERSION, PRO_VERSION

const versions = {
  local: process.env.LOCAL_VERSION || '0.0.0',
  conso: process.env.CONSO_VERSION || '1.0.0',
  int: process.env.INT_VERSION || '1.1.0',
  pre: process.env.PRE_VERSION || '1.2.0',
  pro: process.env.PRO_VERSION || '1.3.0',
};

const argvPort = Number(process.argv[2]);
const port = Number.isFinite(argvPort) ? argvPort : process.env.PORT || 8888;

const randomVersion = () => {
  const major = Math.floor(Math.random() * 3) + 1;
  const minor = Math.floor(Math.random() * 10);
  const patch = Math.floor(Math.random() * 20);
  return `${major}.${minor}.${patch}`;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  const shouldFail = Math.random() < 0.2; // 1 de cada 5
  const envMap = {
    '/local/version': 'local',
    '/conso/version': 'conso',
    '/int/version': 'int',
    '/pre/version': 'pre',
    '/pro/version': 'pro',
  };

  if (envMap[path]) {
    const env = envMap[path];

    if (shouldFail) {
      const failTimeout = Math.random() < 0.5; // mitad timeout, mitad error HTTP
      if (failTimeout) {
        // Simula timeout: no respondemos en absoluto
        return;
      }
      const codes = [500, 502, 503, 404];
      const status = codes[Math.floor(Math.random() * codes.length)];
      setTimeout(() => {
        res.statusCode = status;
        res.end(`error ${status}`);
      }, Math.floor(Math.random() * 2000));
      return;
    }

    // éxito con retardo 0-2s y versión aleatoria
    const delay = Math.floor(Math.random() * 2000);
    setTimeout(() => ok(res, randomVersion()), delay);
    return;
  }

  res.statusCode = 404;
  res.end('not found');
});

function ok(res, body) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end(body);
}

server.listen(port, () => {
  console.log(`Version dummy server listening on ${port}`);
  console.log('Endpoints:');
  console.log(`  http://localhost:${port}/local/version -> ${versions.local}`);
  console.log(`  http://localhost:${port}/conso/version -> ${versions.conso}`);
  console.log(`  http://localhost:${port}/int/version   -> ${versions.int}`);
  console.log(`  http://localhost:${port}/pre/version   -> ${versions.pre}`);
  console.log(`  http://localhost:${port}/pro/version   -> ${versions.pro}`);
});
