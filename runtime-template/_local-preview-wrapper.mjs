// src/server.js es un handler serverless puro (Vercel via api/index.js) y nunca abre un
// servidor HTTP propio a propósito — Vercel detecta ese patrón por análisis de texto y rompe
// el deploy. Este wrapper es el único lugar permitido para levantar un servidor real, y sólo
// se usa fuera de Vercel (preview local, Docker/VPS).
import http from 'node:http';
import { handleRequest } from './src/server.js';

const port = Number(process.env.PORT || 3000);
const host = '127.0.0.1';
http.createServer(handleRequest).listen(port, host, () => {
  console.log(`ZeroAgent runtime escuchando en http://${host}:${port}`);
});
