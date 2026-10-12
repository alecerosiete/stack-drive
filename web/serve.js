#!/usr/bin/env node
'use strict';

/**
 * Servidor estático mínimo para el panel de prueba, sin dependencias.
 *
 * No hace falta nada más elaborado: el panel es HTML/CSS/JS plano que habla
 * con la API por `fetch`. Sirve `web/` en http://localhost:5173, el origen
 * que trae preconfigurado `CORS_ORIGINS` en `.env.example`.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.WEB_PORT ?? 5173);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  // El panel es una sola página: cualquier ruta sin extensión de archivo
  // (incluida la que deja el callback de Google con query params) sirve
  // index.html y deja que el propio JS lea `location.search`.
  let relativePath = requestUrl.pathname === '/' || !path.extname(requestUrl.pathname)
    ? '/index.html'
    : requestUrl.pathname;

  const filePath = path.join(ROOT, relativePath);

  // No servir nada fuera de `web/`.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Prohibido');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end('No encontrado');
      return;
    }
    const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Panel de prueba de StackDrive en http://localhost:${PORT}`);
});
