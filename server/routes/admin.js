/**
 * The admin side of sharing: who exists, what each of them may download.
 * Every route here sits behind `requireAdmin` in server/index.js.
 */
import { Router } from 'express';
import * as shares from '../shares.js';
import { assertOwnedKey, HttpError } from '../keys.js';
import { authEnabled } from '../auth.js';

export const adminRouter = Router();

// Recipients are told apart by their password, so an app with no password of its
// own has nothing to tell them apart from.
adminRouter.use((_req, _res, next) => {
  if (!authEnabled) {
    throw new HttpError(400, 'Set APP_PASSWORD before sharing files — otherwise the app is open to everyone.');
  }
  next();
});

adminRouter.get('/users', async (_req, res) => {
  res.json({ users: await shares.listUsers() });
});

/** A fresh password is generated unless one is supplied, and shown exactly once. */
adminRouter.post('/users', async (req, res) => {
  const { name, password } = req.body ?? {};
  const created = await shares.createUser({ name, password });
  res.status(201).json(created);
});

adminRouter.post('/users/:id/password', async (req, res) => {
  res.json(await shares.setPassword(req.params.id, req.body?.password));
});

adminRouter.patch('/users/:id', async (req, res) => {
  res.json({ user: await shares.renameUser(req.params.id, req.body?.name) });
});

adminRouter.delete('/users/:id', async (req, res) => {
  res.json(await shares.deleteUser(req.params.id));
});

/** Replace the whole list of files one recipient can see. */
adminRouter.put('/users/:id/files', async (req, res) => {
  const keys = req.body?.keys;
  if (!Array.isArray(keys)) throw new HttpError(400, 'keys must be an array');
  if (keys.length > 500) throw new HttpError(400, 'At most 500 files per recipient');
  res.json({ user: await shares.setUserFiles(req.params.id, keys.map(assertOwnedKey)) });
});

/** A suggested password for the form, so the admin never has to invent one. */
adminRouter.get('/suggest-password', (_req, res) => {
  res.json({ password: shares.generatePassword() });
});
