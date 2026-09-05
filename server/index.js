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
const auth = await import('./auth.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1); // Railway and friends terminate TLS in front of us
app.use(express.json({ limit: '1mb' }));

const publicDir = path.join(here, '..', 'public');

// Railway (and any other platform) polls this to decide if the deploy is live, so it
// stays reachable without a session.
app.get('/healthz', (_req, res) => res.json({ status: 'ok', bucket: config.bucket }));

// ---- authentication (only active when APP_PASSWORD is set) ----

app.get('/login', (req, res) => {
  if (!auth.authEnabled || auth.isSignedIn(req)) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.post('/api/login', async (req, res) => {
  if (!auth.authEnabled) return res.json({ ok: true });

  await auth.jitter();
  if (auth.tooManyAttempts(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  if (!auth.checkPassword(req.body?.password)) {
    auth.recordFailure(req.ip);
    return res.status(401).json({ error: 'Wrong password' });
  }

  auth.clearAttempts(req.ip);
  auth.setSessionCookie(req, res, auth.signSession());
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Everything past this point needs a session: the API answers 401 so the page can
// react, a browser asking for a page is sent to the login form.
app.use((req, res, next) => {
  if (auth.isSignedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  res.redirect('/login');
});

app.use(express.static(publicDir, { maxAge: '1h' }));

app.get('/api/config', (_req, res) => {
  res.json({
    bucket: config.bucket,
    maxFileSize: config.maxFileSize,
    defaultPartSize: 16 * 1024 * 1024,
    defaultConcurrency: 4,
    auth: auth.authEnabled,
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
  console.log(
    auth.authEnabled
      ? 'auth: password required'
      : 'auth: OPEN — anyone who can reach this server can upload and delete. Set APP_PASSWORD to lock it down.'
  );
});
