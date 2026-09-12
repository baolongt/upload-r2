/**
 * The admin's view of sharing: a list of recipients, and for each one the set of
 * files they may download. A recipient signs in with nothing but their password,
 * so the password is what the admin has to pass on — and since only its digest is
 * stored, it is shown once, here, and can only be replaced afterwards.
 */
import { api } from './api.js';
import { button, el, formatBytes, formatDate } from './format.js';

let users = [];
let bucketFiles = () => [];
let container;
let openFor = null; // id of the recipient whose file picker is open

export function initRecipients({ files }) {
  bucketFiles = files;
  container = el('recipients');
  wireForm();
  return refreshRecipients();
}

export async function refreshRecipients() {
  try {
    ({ users } = await api.listUsers());
    render();
  } catch (error) {
    container.replaceChildren(message(`Could not load recipients: ${error.message}`));
  }
}

/** Redraw the picker when the bucket listing changes underneath it. */
export function recipientsFilesChanged() {
  if (container && users.length) render();
}

function message(text) {
  const node = document.createElement('p');
  node.className = 'muted empty';
  node.textContent = text;
  return node;
}

function render() {
  container.replaceChildren();
  if (users.length === 0) {
    container.append(message('No recipients yet. Add one and they can sign in with just their password.'));
    return;
  }
  for (const user of users) container.append(recipientRow(user));
}

function recipientRow(user) {
  const node = document.createElement('div');
  node.className = 'item recipient';

  const head = document.createElement('div');
  head.className = 'item-head';
  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = user.name;
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.textContent = `${user.keys.length} file${user.keys.length === 1 ? '' : 's'} · added ${formatDate(
    user.createdAt
  )}`;
  head.append(name, meta);

  const foot = document.createElement('div');
  foot.className = 'item-foot';
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = user.keys.length
    ? user.keys.map((key) => nameOf(key)).join(', ')
    : 'Nothing shared yet';
  const actions = document.createElement('span');
  actions.className = 'actions';
  actions.append(
    button(openFor === user.id ? 'Close' : 'Choose files', 'ghost', () => {
      openFor = openFor === user.id ? null : user.id;
      render();
    }),
    button('Rename', 'ghost', () => rename(user)),
    button('New password', 'ghost', () => resetPassword(user)),
    button('Remove', 'ghost danger', () => remove(user))
  );
  foot.append(status, actions);

  node.append(head, foot);
  if (openFor === user.id) node.append(filePicker(user));
  return node;
}

/** The display name of a key, matching what the file listing shows. */
const nameOf = (key) => key.slice(key.lastIndexOf('/') + 1).replace(/^[0-9a-f]{12}-/, '');

function filePicker(user) {
  const panel = document.createElement('div');
  panel.className = 'picker';

  const files = bucketFiles();
  if (files.length === 0) {
    panel.append(message('Upload a file first, then you can share it.'));
    return panel;
  }

  const chosen = new Set(user.keys);
  const list = document.createElement('div');
  list.className = 'picker-list';

  for (const file of files) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = chosen.has(file.key);
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(file.key);
      else chosen.delete(file.key);
    });
    const text = document.createElement('span');
    text.textContent = `${file.name} · ${formatBytes(file.size)}`;
    label.append(box, text);
    list.append(label);
  }

  // A key can point at a file that is no longer in the listing (deleted, or past
  // the first page). Keep it selectable rather than silently dropping it on save.
  for (const key of user.keys) {
    if (files.some((file) => file.key === key)) continue;
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(key);
      else chosen.delete(key);
    });
    const text = document.createElement('span');
    text.className = 'muted';
    text.textContent = `${nameOf(key)} · not in the current listing`;
    label.append(box, text);
    list.append(label);
  }

  const feedback = document.createElement('p');
  feedback.className = 'muted';

  const save = button('Save', '', async () => {
    save.disabled = true;
    feedback.textContent = 'Saving…';
    try {
      await api.setUserFiles(user.id, [...chosen]);
      await refreshRecipients();
    } catch (error) {
      feedback.textContent = `Could not save: ${error.message}`;
      save.disabled = false;
    }
  });

  const row = document.createElement('div');
  row.className = 'picker-foot';
  row.append(save, feedback);
  panel.append(list, row);
  return panel;
}

/** Shows a freshly minted password once, with a button to copy it. */
function showPassword(user, password) {
  const existing = el('new-password');
  if (existing) existing.remove();

  const box = document.createElement('div');
  box.id = 'new-password';
  box.className = 'password-box';

  const text = document.createElement('div');
  text.textContent = `Password for ${user.name} — copy it now, it is not stored in a form anyone can read back:`;
  const code = document.createElement('code');
  code.textContent = password;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const copy = button('Copy', 'ghost', async () => {
    try {
      await navigator.clipboard.writeText(password);
      copy.textContent = 'Copied';
    } catch {
      // Clipboard access can be refused; the password is on screen either way.
      copy.textContent = 'Select it by hand';
    }
  });
  actions.append(copy, button('Dismiss', 'ghost', () => box.remove()));

  box.append(text, code, actions);
  container.before(box);
}

/* ---------- the add form ---------- */

function wireForm() {
  const form = el('recipient-form');
  const name = el('recipient-name');
  const password = el('recipient-password');
  const error = el('recipient-error');
  const save = el('recipient-save');

  const close = () => {
    form.hidden = true;
    error.textContent = '';
    el('add-recipient').hidden = false;
  };

  el('add-recipient').addEventListener('click', async () => {
    form.hidden = false;
    el('add-recipient').hidden = true;
    error.textContent = '';
    name.value = '';
    password.value = await suggestPassword();
    name.focus();
  });

  el('recipient-cancel').addEventListener('click', close);
  el('recipient-regenerate').addEventListener('click', async () => {
    password.value = await suggestPassword();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    save.disabled = true;
    try {
      const created = await api.createUser(name.value, password.value);
      close();
      await refreshRecipients();
      showPassword(created.user, created.password);
      // Straight into picking their files — that is the point of adding them.
      openFor = created.user.id;
      render();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      save.disabled = false;
    }
  });
}

/** The server picks the password, so the admin never has to invent one. */
async function suggestPassword() {
  try {
    const { password } = await api.suggestPassword();
    return password;
  } catch {
    // The server generates one anyway if the field is sent empty.
    return '';
  }
}

async function rename(user) {
  const name = prompt('New name:', user.name);
  if (name === null) return;
  try {
    await api.renameUser(user.id, name);
    await refreshRecipients();
  } catch (error) {
    alert(`Could not rename: ${error.message}`);
  }
}

async function resetPassword(user) {
  const suggested = await suggestPassword();
  const password = prompt(`New password for ${user.name}. The old one stops working immediately.`, suggested);
  if (password === null) return;
  try {
    const updated = await api.resetPassword(user.id, password);
    await refreshRecipients();
    showPassword(updated.user, updated.password);
  } catch (error) {
    alert(`Could not change the password: ${error.message}`);
  }
}

async function remove(user) {
  if (!confirm(`Remove ${user.name}? Their password stops working, the files stay in the bucket.`)) return;
  try {
    await api.deleteUser(user.id);
    if (openFor === user.id) openFor = null;
    await refreshRecipients();
  } catch (error) {
    alert(`Could not remove: ${error.message}`);
  }
}
