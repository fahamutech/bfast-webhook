import {createServer} from 'node:http';
import {githubWebhook} from './functions/index.mjs';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

createServer((request, response) => {
  const match = /^\/github-webhook\/([A-Za-z0-9][\w.-]*)$/.exec(request.url || '');
  if (request.method !== 'POST' || !match) {
    response.writeHead(404).end('Not found');
    return;
  }
  request.params = {service: match[1]};
  githubWebhook.onRequest(request, response);
}).listen(port, '0.0.0.0', () => console.log(`GitHub webhook listening on ${port}`));
