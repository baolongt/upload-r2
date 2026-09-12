/** Formatting and DOM odds and ends shared by the admin page and the recipient page. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);

export const formatDate = (value) => new Date(value).toLocaleString();

export const el = (id) => document.getElementById(id);

export function button(label, className, onClick) {
  const node = document.createElement('button');
  node.textContent = label;
  if (className) node.className = className;
  node.addEventListener('click', onClick);
  return node;
}

/** Bytes per second over the last few seconds, or null until there is enough to go on. */
export function speedOf(entry, loaded) {
  const now = performance.now();
  entry.samples.push({ t: now, loaded });
  while (entry.samples.length > 2 && now - entry.samples[0].t > 5000) entry.samples.shift();
  const first = entry.samples[0];
  const elapsed = (now - first.t) / 1000;
  if (elapsed < 0.4) return null;
  return (loaded - first.loaded) / elapsed;
}

export function rowTemplate(name, size) {
  const node = document.createElement('div');
  node.className = 'item';
  node.innerHTML = `
    <div class="item-head">
      <span class="item-name"></span>
      <span class="item-meta">${formatBytes(size)}</span>
    </div>
    <div class="bar"><span></span></div>
    <div class="item-foot">
      <span class="status"></span>
      <span class="actions"></span>
    </div>`;
  node.querySelector('.item-name').textContent = name;
  return node;
}
