/**
 * A tiny in-memory stand-in for R2's S3 API: enough of multipart upload, ranged
 * GET and object listing to drive the real client and server code in tests.
 * Signatures are not verified — this exists to exercise our own logic.
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const xmlEscape = (value) =>
  String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');

export function createMockR2({ bucket = 'demo', partDelayMs = 0 } = {}) {
  const objects = new Map(); // key -> { body, contentType, lastModified }
  const uploads = new Map(); // uploadId -> { key, parts: Map<number, Buffer> }
  const stats = { partPuts: 0, rangeGets: 0, listParts: 0 };

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PUT,POST,HEAD,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'ETag,Content-Length,Content-Range,Content-Type',
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body = '', headers = {}) => {
      res.writeHead(status, { ...cors, ...headers });
      res.end(body);
    };

    if (req.method === 'OPTIONS') return send(204);

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== bucket) return send(404, '<Error><Code>NoSuchBucket</Code></Error>');
    const key = decodeURIComponent(segments.slice(1).join('/'));
    const uploadId = url.searchParams.get('uploadId');

    // ---- bucket listing ----
    if (!key && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(
          ([objectKey, object]) =>
            `<Contents><Key>${xmlEscape(objectKey)}</Key><Size>${object.body.length}</Size>` +
            `<LastModified>${object.lastModified}</LastModified><ETag>&quot;${md5(object.body)}&quot;</ETag></Contents>`
        )
        .join('');
      return send(
        200,
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name>` +
          `<Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${objects.size}</KeyCount>` +
          `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        { 'content-type': 'application/xml' }
      );
    }

    // ---- multipart: create ----
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID();
      uploads.set(id, { key, parts: new Map() });
      return send(
        200,
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket>` +
          `<Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        { 'content-type': 'application/xml' }
      );
    }

    // ---- multipart: upload part ----
    if (req.method === 'PUT' && uploadId && url.searchParams.has('partNumber')) {
      const upload = uploads.get(uploadId);
      if (!upload) return send(404, '<Error><Code>NoSuchUpload</Code></Error>');
      const body = await readBody(req);
      stats.partPuts += 1;
      // Optional slow-down, so tests have time to hit pause mid-upload.
      if (partDelayMs) await new Promise((resolve) => setTimeout(resolve, partDelayMs));
      const partNumber = Number(url.searchParams.get('partNumber'));
      upload.parts.set(partNumber, body);
      return send(200, '', { ETag: `"${md5(body)}"` });
    }

    // ---- multipart: list parts (used to resume) ----
    if (req.method === 'GET' && uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload) return send(404, '<Error><Code>NoSuchUpload</Code></Error>');
      stats.listParts += 1;
      const parts = [...upload.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(
          ([number, body]) =>
            `<Part><PartNumber>${number}</PartNumber><Size>${body.length}</Size><ETag>&quot;${md5(body)}&quot;</ETag></Part>`
        )
        .join('');
      return send(
        200,
        `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult><Bucket>${bucket}</Bucket>` +
          `<Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId><IsTruncated>false</IsTruncated>` +
          `${parts}</ListPartsResult>`,
        { 'content-type': 'application/xml' }
      );
    }

    // ---- multipart: complete ----
    if (req.method === 'POST' && uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload) return send(404, '<Error><Code>NoSuchUpload</Code></Error>');
      const body = (await readBody(req)).toString('utf8');
      const numbers = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match) => Number(match[1]));
      const missing = numbers.filter((number) => !upload.parts.has(number));
      if (missing.length) return send(400, `<Error><Code>InvalidPart</Code><Message>${missing}</Message></Error>`);
      const assembled = Buffer.concat(numbers.map((number) => upload.parts.get(number)));
      objects.set(upload.key, {
        body: assembled,
        contentType: 'application/octet-stream',
        lastModified: new Date().toISOString(),
      });
      uploads.delete(uploadId);
      return send(
        200,
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${bucket}</Bucket>` +
          `<Key>${xmlEscape(upload.key)}</Key><ETag>&quot;${md5(assembled)}&quot;</ETag></CompleteMultipartUploadResult>`,
        { 'content-type': 'application/xml' }
      );
    }

    // ---- multipart: abort ----
    if (req.method === 'DELETE' && uploadId) {
      uploads.delete(uploadId);
      return send(204);
    }

    // ---- plain object operations ----
    if (req.method === 'PUT') {
      const body = await readBody(req);
      objects.set(key, {
        body,
        contentType: req.headers['content-type'] ?? 'application/octet-stream',
        lastModified: new Date().toISOString(),
      });
      return send(200, '', { ETag: `"${md5(body)}"` });
    }

    if (req.method === 'HEAD' || req.method === 'GET') {
      const object = objects.get(key);
      if (!object) return send(404, req.method === 'HEAD' ? '' : '<Error><Code>NoSuchKey</Code></Error>');
      const headers = {
        'content-type': object.contentType,
        'last-modified': new Date(object.lastModified).toUTCString(),
        ETag: `"${md5(object.body)}"`,
        'accept-ranges': 'bytes',
      };
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        stats.rangeGets += 1;
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), object.body.length - 1) : object.body.length - 1;
        const slice = object.body.subarray(start, end + 1);
        res.writeHead(206, {
          ...cors,
          ...headers,
          'content-length': slice.length,
          'content-range': `bytes ${start}-${end}/${object.body.length}`,
        });
        return res.end(req.method === 'HEAD' ? undefined : slice);
      }
      res.writeHead(200, { ...cors, ...headers, 'content-length': object.body.length });
      return res.end(req.method === 'HEAD' ? undefined : object.body);
    }

    if (req.method === 'DELETE') {
      objects.delete(key);
      return send(204);
    }

    return send(400, '<Error><Code>NotImplemented</Code></Error>');
  });

  return {
    server,
    objects,
    uploads,
    stats,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
