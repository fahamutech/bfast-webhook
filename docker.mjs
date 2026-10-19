// Thin Docker Engine API client over the Unix socket, plus log demultiplexing.
import {request} from 'node:http';

export const fail = (status, message) => Object.assign(new Error(message), {status});
export const filters = object => encodeURIComponent(JSON.stringify(object));

export function dockerRequest(method, path, body, {raw = false, timeout = 10000, limit = 8_000_000} = {}) {
  return new Promise((resolve, reject) => {
    const req = request({socketPath: '/var/run/docker.sock', path, method,
      headers: {'Content-Type': 'application/json'}}, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { chunks.push(chunk); size += chunk.length; if (size > limit) req.destroy(new Error('Response too large')); });
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let message = 'Docker operation failed';
          try { const parsed = JSON.parse(data.toString('utf8')); if (typeof parsed.message === 'string') message = parsed.message; } catch {}
          if (res.statusCode === 404) return reject(fail(404, 'Not found in Swarm'));
          if (res.statusCode === 409) return reject(fail(409, 'Docker resource changed or its name is already in use. Refresh and retry.'));
          if (res.statusCode < 500) return reject(fail(400, `Docker rejected the request: ${message.slice(0, 400)}`));
          return reject(fail(502, 'Docker operation failed'));
        }
        if (raw) return resolve(data);
        try { resolve(data.length ? JSON.parse(data.toString('utf8')) : {}); } catch { reject(fail(502, 'Invalid Docker response')); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Docker timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// Docker multiplexes stdout/stderr into 8-byte framed chunks when the task has no TTY.
export function demuxLogs(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return '';
  const framed = buffer.length >= 8 && buffer[0] <= 2 && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0;
  if (!framed) return buffer.toString('utf8');
  const parts = []; let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    parts.push(buffer.subarray(offset + 8, Math.min(offset + 8 + length, buffer.length)).toString('utf8'));
    offset += 8 + length;
  }
  return parts.join('');
}
