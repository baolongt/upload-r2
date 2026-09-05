import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Loaded dynamically so a missing .env produces one clear line instead of a stack trace.
const { config } = await import('./config.js').catch((error) => {
  console.error(`\nupload-r2 cannot start: ${error.message}\n`);
  process.exit(1);
});
const { uploadsRouter } = await import('./routes/uploads.js');
const { filesRouter } = await import('./routes/files.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, '..', 'public'), { maxAge: '1h' }));

// Railway (and any other platform) polls this to decide if the deploy is live.
app.get('/healthz', (_req, res) => res.json({ status: 'ok', bucket: config.bucket }));

app.get('/api/config', (_req, res) => {
  res.json({
    bucket: config.bucket,
    maxFileSize: config.maxFileSize,
    defaultPartSize: 16 * 1024 * 1024,
    defaultConcurrency: 4,
  });
});

app.use('/api/uploads', uploadsRouter);
app.use('/api/files', filesRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Express 5 forwards rejected promises from route handlers here.
app.use((error, _req, res, _next) => {
  const status = error.status ?? error.$metadata?.httpStatusCode ?? 500;
  if (status >= 500) console.error(error);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error.message || 'Something went wrong',
  });
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`upload-r2 listening on http://localhost:${config.port}`);
  console.log(`bucket: ${config.bucket}  endpoint: ${config.endpoint}`);
});
