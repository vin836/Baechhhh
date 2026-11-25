// 重點筆記：資料只存在這台裝置的 localStorage，可匯出 / 匯入 JSON 備份。
'use strict';

const STORE_KEY = 'study-notes-v1';
const ALL = '全部';

const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const chipsEl = $('#chips');
const searchEl = $('#search');
const viewer = $('#viewer');
const editor = $('#editor');
const form = $('#editForm');

let state = load();
let activeCat = ALL;
let currentId = null;

/* ---------- 儲存 ---------- */

function load() {
  let data;
  try { data = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { data = null; }
  if (!data || !Array.isArray(data.notes)) data = { seedVersion: 0, notes: [] };
  return mergeSeed(data);
}

// 補上新的內建筆記；內建筆記若沒被使用者改過（edited=false）就更新成新版內容。
function mergeSeed(data) {
  if ((data.seedVersion || 0) >= window.SEED_VERSION) return data;
  const deleted = new Set(data.deletedSeeds || []);
  const now = Date.now();
  for (const s of window.SEED_NOTES) {
    if (deleted.has(s.id)) continue;
    const existing = data.notes.find((n) => n.id === s.id);
    if (!existing) {
      data.notes.push({ ...s, pinned: !!s.pinned, seed: true, edited: false, created: now, updated: now });
    } else if (!existing.edited) {
      Object.assign(existing, { title: s.title, cat: s.cat, body: s.body, updated: now });
    }
  }
  data.seedVersion = window.SEED_VERSION;
  save(data);
  return data;
}

function save(data = state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

/* ---------- 簡易 Markdown（先跳脫 HTML，只允許 http/https 連結） ---------- */

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s（(：])(https?:\/\/[^\s<）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function render(body) {
  const lines = body.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().slice(1, -1).split('|').map((c) => c.trim());
      const isSep = (r) => /^[\s|:-]+$/.test(r);
      let html = '<div class="table-wrap"><table>';
      rows.forEach((r, idx) => {
        if (isSep(r)) return;
        const tag = idx === 0 && rows[1] && isSep(rows[1]) ? 'th' : 'td';
        html += `<tr>${cells(r).map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`;
      });
      out.push(html + '</table></div>');
      continue;
    }
    if (/^\s*(- |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const items = [];
      while (i < lines.length && /^\s*(- |\d+\. )/.test(lines[i])) {
        const raw = lines[i];
        const task = raw.match(/^\s*- \[( |x|X)\] (.*)$/);
        if (task) {
          const done = task[1] !== ' ';
          items.push(`<li class="task${done ? ' done' : ''}"><label><input type="checkbox" data-line="${i}"${done ? ' checked' : ''}><span>${inline(task[2])}</span></label></li>`);
        } else {
          items.push(`<li>${inline(raw.replace(/^\s*(- |\d+\. )/, ''))}</li>`);
        }
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    if (/^#{1,3} /.test(line)) { out.push(`<h3>${inline(line.replace(/^#+ /, ''))}</h3>`); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(\s*\||\s*- |\s*\d+\. |#{1,3} |```)/.test(lines[i])) para.push(inline(lines[i++]));
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('');
}

const plain = (body) => body
  .replace(/^\s*(- \[[ xX]\] |- |\d+\. |#+ )/gm, '')
  .replace(/^\s*\|[\s|:-]+\|\s*$/gm, '')
  .replace(/[*`|]/g, ' ')
  .replace(/\s+/g, ' ').trim();
const taskCount = (body) => {
  const all = body.match(/^\s*- \[( |x|X)\] /gm) || [];
  const done = all.filter((t) => /\[(x|X)\]/.test(t)).length;
  return all.length ? `${done}/${all.length} 完成` : '';
};
const fmtDate = (t) => new Date(t).toLocaleString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/* ---------- 列表 ---------- */

function categories() {
  const counts = new Map();
  for (const n of state.notes) counts.set(n.cat, (counts.get(n.cat) || 0) + 1);
  return counts;
}

function renderChips() {
  const counts = categories();
  if (activeCat !== ALL && !counts.has(activeCat)) activeCat = ALL;
  const cats = [[ALL, state.notes.length], ...counts];
  chipsEl.innerHTML = cats.map(([c, n]) =>
    `<button class="chip" role="tab" data-cat="${esc(c)}" aria-selected="${c === activeCat}">${esc(c)}<b>${n}</b></button>`).join('');
  $('#catList').innerHTML = [...counts.keys()].map((c) => `<option value="${esc(c)}">`).join('');
}

function renderList() {
  renderChips();
  const q = searchEl.value.trim().toLowerCase();
  const notes = state.notes
    .filter((n) => activeCat === ALL || n.cat === activeCat)
    .filter((n) => !q || (n.title + ' ' + n.body + ' ' + n.cat).toLowerCase().includes(q))
    .sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));

  if (!notes.length) {
    listEl.innerHTML = `<p class="empty">${q ? '找不到符合的筆記' : '還沒有筆記，按右下角 ＋ 新增'}</p>`;
    return;
  }
  const card = (n) => `
    <button class="card" data-id="${esc(n.id)}">
      <div class="card-top">${n.pinned ? '📌' : ''}<span class="card-cat">${esc(n.cat)}</span><span class="card-progress">${taskCount(n.body)}</span></div>
      <h2>${esc(n.title)}</h2>
      <p>${esc(plain(n.body).slice(0, 140))}</p>
    </button>`;
  const pinned = notes.filter((n) => n.pinned);
  const rest = notes.filter((n) => !n.pinned);
  listEl.innerHTML =
    (pinned.length && rest.length ? '<p class="section-label">已釘選</p>' : '') + pinned.map(card).join('') +
    (pinned.length && rest.length ? '<p class="section-label">其他</p>' : '') + rest.map(card).join('');
}

/* ---------- 檢視 ---------- */

const find = (id) => state.notes.find((n) => n.id === id);

function openViewer(id) {
  const n = find(id);
  if (!n) return;
  currentId = id;
  $('#vCat').textContent = n.cat;
  $('#vTitle').textContent = n.title;
  $('#vMeta').textContent = `更新於 ${fmtDate(n.updated)}${n.seed && !n.edited ? '・內建筆記' : ''}`;
  $('#vBody').innerHTML = render(n.body);
  $('#vPin').textContent = n.pinned ? '★' : '☆';
  $('#vPin').setAttribute('aria-label', n.pinned ? '取消釘選' : '釘選');
  if (!viewer.open) viewer.showModal();
  viewer.scrollTop = 0;
}

$('#vBody').addEventListener('change', (e) => {
  const box = e.target.closest('input[type=checkbox][data-line]');
  const n = find(currentId);
  if (!box || !n) return;
  const lines = n.body.split('\n');
  const idx = Number(box.dataset.line);
  lines[idx] = lines[idx].replace(/- \[( |x|X)\]/, box.checked ? '- [x]' : '- [ ]');
  n.body = lines.join('\n');
  n.updated = Date.now();
  if (n.seed) n.edited = true;
  save();
  box.closest('li').classList.toggle('done', box.checked);
  renderList();
});

$('#vPin').addEventListener('click', () => {
  const n = find(currentId);
  n.pinned = !n.pinned;
  save();
  openViewer(n.id);
  renderList();
});

$('#vEdit').addEventListener('click', () => { viewer.close(); openEditor(currentId); });

/* ---------- 編輯 ---------- */

function openEditor(id = null) {
  currentId = id;
  const n = id ? find(id) : null;
  form.reset();
  form.title.value = n ? n.title : '';
  form.cat.value = n ? n.cat : (activeCat !== ALL ? activeCat : '');
  form.body.value = n ? n.body : '';
  $('#eHeading').textContent = n ? '編輯筆記' : '新增筆記';
  $('#eDelete').hidden = !n;
  editor.showModal();
  (n ? form.body : form.title).focus();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = form.title.value.trim();
  const cat = form.cat.value.trim() || '未分類';
  const body = form.body.value.replace(/\s+$/, '');
  if (!title) return;
  const now = Date.now();
  let n = currentId ? find(currentId) : null;
  if (n) {
    Object.assign(n, { title, cat, body, updated: now });
    if (n.seed) n.edited = true;
  } else {
    n = { id: 'n-' + now.toString(36) + Math.random().toString(36).slice(2, 6), title, cat, body, pinned: false, seed: false, edited: true, created: now, updated: now };
    state.notes.push(n);
  }
  save();
  editor.close();
  renderList();
  openViewer(n.id);
  toast('已儲存');
});

$('#eDelete').addEventListener('click', () => {
  const n = find(currentId);
  if (!n || !confirm(`確定刪除「${n.title}」？`)) return;
  state.notes = state.notes.filter((x) => x.id !== n.id);
  if (n.seed) state.deletedSeeds = [...new Set([...(state.deletedSeeds || []), n.id])];
  save();
  editor.close();
  renderList();
  toast('已刪除');
});

/* ---------- 選單：匯出 / 匯入 / 還原 ---------- */

const menu = $('#menu');
$('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', () => { menu.hidden = true; });

menu.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (act === 'export') {
    const blob = new Blob([JSON.stringify({ app: 'study-notes', exported: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `重點筆記備份-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else if (act === 'import') {
    $('#importFile').click();
  } else if (act === 'reset-seed') {
    if (!confirm('把內建筆記還原成原始內容？你自己新增的筆記不會受影響。')) return;
    state.notes = state.notes.filter((n) => !n.seed);
    state.deletedSeeds = [];
    state.seedVersion = 0;
    state = mergeSeed(state);
    renderList();
    toast('內建筆記已還原');
  }
});

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.notes)) throw new Error('格式不對');
    let added = 0, updated = 0;
    for (const raw of data.notes) {
      if (!raw || typeof raw.title !== 'string' || typeof raw.body !== 'string') continue;
      const n = { id: String(raw.id || 'n-' + Math.random().toString(36).slice(2)), title: raw.title, cat: String(raw.cat || '未分類'), body: raw.body, pinned: !!raw.pinned, seed: !!raw.seed, edited: raw.edited !== false, created: Number(raw.created) || Date.now(), updated: Number(raw.updated) || Date.now() };
      const existing = find(n.id);
      if (!existing) { state.notes.push(n); added++; }
      else if (n.updated > existing.updated) { Object.assign(existing, n); updated++; }
    }
    save();
    renderList();
    toast(`匯入完成：新增 ${added}、更新 ${updated}`);
  } catch {
    toast('匯入失敗：不是這個 App 的備份檔');
  }
});

/* ---------- 其他 ---------- */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

chipsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  activeCat = chip.dataset.cat;
  renderList();
});
listEl.addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) openViewer(c.dataset.id); });
searchEl.addEventListener('input', renderList);
$('#addBtn').addEventListener('click', () => openEditor());
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

renderList();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
