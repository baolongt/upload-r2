/**
 * One row for a file that already lives in the bucket, with the download button
 * wired up. The admin page passes `onDelete` and gets a Delete button too; the
 * recipient page does not, and gets a row that can only download.
 */
import { api } from './api.js';
import { ChunkedDownload, openDiskWriter, shouldStreamToDisk } from './downloader.js';
import { button, capitalize, formatBytes, formatDate, formatDuration, rowTemplate, speedOf } from './format.js';

export function fileRow(file, { concurrency = () => 4, onDelete = null } = {}) {
  const node = rowTemplate(file.name, file.size);
  node.querySelector('.item-meta').textContent = `${formatBytes(file.size)} · ${formatDate(file.lastModified)}`;
  const status = node.querySelector('.status');
  const actions = node.querySelector('.actions');
  const bar = node.querySelector('.bar > span');
  status.textContent = 'Ready';

  let remove = null;

  const download = button('Download', '', async () => {
    // The save dialog has to be opened here, while the click is still counted as a
    // user gesture — asking for the presigned URL first would spend it, and the
    // dialog would then never appear.
    let writer = null;
    if (shouldStreamToDisk(file.size)) {
      try {
        status.textContent = 'Choose where to save…';
        writer = await openDiskWriter(file.name);
      } catch (error) {
        status.textContent = error?.name === 'AbortError' ? 'Ready' : `Failed: ${error.message}`;
        return;
      }
    } else if (file.size > 512 * 1024 * 1024) {
      status.textContent = 'Buffering in memory (browser cannot stream to disk)…';
    }

    const labels = {
      preparing: 'Requesting download link…',
      assembling: 'Assembling the file — this can take a while for a large one…',
      saving: 'Handing the file to the browser…',
    };

    const samples = [];
    const render = (d) => {
      bar.style.width = `${(d.progress * 100).toFixed(1)}%`;
      if (d.state === 'downloading') {
        const speed = speedOf({ samples }, d.loaded);
        const remaining = speed ? (d.size - d.loaded) / speed : NaN;
        const stalled = d.stalledForSeconds;
        const warning = stalled > 10 ? ` · no data for ${Math.round(stalled)}s, retrying` : '';
        const rate = speed && !warning ? ` · ${formatBytes(speed)}/s · ${formatDuration(remaining)} left` : '';
        status.textContent =
          `${(d.progress * 100).toFixed(1)}% · ${formatBytes(d.loaded)} of ${formatBytes(d.size)}${rate}${warning}`;
      } else if (d.state === 'error') {
        status.textContent = `Failed: ${d.error?.message ?? 'unknown error'}`;
        node.classList.add('error');
      } else if (d.state === 'done') {
        status.textContent = 'Downloaded';
        node.classList.add('done');
      } else {
        status.textContent = labels[d.state] ?? capitalize(d.state);
      }
    };

    const job = new ChunkedDownload(file.key, { concurrency: concurrency(), writer, onChange: render });

    // A download that stops receiving data used to look identical to one that is
    // simply slow, so the status is refreshed on a timer too, not only on progress.
    const ticker = setInterval(() => render(job), 1000);
    const cancel = button('Cancel', 'ghost danger', () => job.cancel());
    download.disabled = true;
    if (remove) remove.disabled = true;
    actions.append(cancel);
    try {
      await job.start();
    } finally {
      clearInterval(ticker);
      cancel.remove();
      download.disabled = false;
      if (remove) remove.disabled = false;
    }
  });

  actions.append(download);

  if (onDelete) {
    remove = button('Delete', 'ghost danger', async () => {
      if (!confirm(`Delete ${file.name} from the bucket?`)) return;
      remove.disabled = true;
      try {
        await api.deleteFile(file.key);
        node.remove();
        onDelete(file);
      } catch (error) {
        status.textContent = `Delete failed: ${error.message}`;
        remove.disabled = false;
      }
    });
    actions.append(remove);
  }

  return node;
}
