/** Thin wrapper around our own backend. It only ever exchanges metadata — no file bytes. */
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  });
  if (response.status === 401) {
    // The session expired or was cleared; the login page takes it from here.
    location.href = '/login';
    throw new Error('Not signed in');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${options.method || 'GET'} ${url} failed (${response.status})`);
  return payload;
}

export const api = {
  config: () => request('/api/config'),

  logout: () => request('/api/logout', { method: 'POST', body: '{}' }),

  createUpload: (file, partSize) =>
    request('/api/uploads/create', {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
        partSize,
      }),
    }),

  signParts: (key, uploadId, partNumbers) =>
    request('/api/uploads/sign', {
      method: 'POST',
      body: JSON.stringify({ key, uploadId, partNumbers }),
    }),

  listParts: (key, uploadId) =>
    request(`/api/uploads/parts?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`),

  completeUpload: (key, uploadId, parts) =>
    request('/api/uploads/complete', {
      method: 'POST',
      body: JSON.stringify({ key, uploadId, parts }),
    }),

  abortUpload: (key, uploadId) =>
    request('/api/uploads/abort', { method: 'POST', body: JSON.stringify({ key, uploadId }) }),

  listFiles: () => request('/api/files'),

  downloadUrl: (key) => request(`/api/files/download-url?key=${encodeURIComponent(key)}`),

  deleteFile: (key) => request(`/api/files?key=${encodeURIComponent(key)}`, { method: 'DELETE' }),
};
