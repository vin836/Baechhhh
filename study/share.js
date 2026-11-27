/* ---------- 🔗 分享題庫：內建題庫給直達連結；自己的題庫把內容壓縮進連結（#import=），同學點開就能匯入 ---------- */

const SHARE_BASE = () => location.origin + location.pathname;
const isBuiltinId = (id) => BUILTIN.some((x) => x.id === id);

const b64u = {
  enc: (bytes) => { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: (str) => { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};

async function gzipStr(str) {
  const cs = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(cs).arrayBuffer());
}
async function gunzipStr(bytes) {
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).text();
}

async function shareLink(b) {
  if (isBuiltinId(b.id)) return `${SHARE_BASE()}#open=${encodeURIComponent(b.id)}`;
  const data = JSON.stringify({ n: b.name, i: b.icon || '📘', t: bankToText(b.questions) });
  return `${SHARE_BASE()}#import=${b64u.enc(await gzipStr(data))}`;
}

async function shareOut(title, text, url) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('🔗 連結已複製，貼給同學就能用'); }
  catch { prompt('複製這個連結分享給同學：', url); }
}

/** 新增一個題庫（同名就加編號），回傳新題庫 */
function addImportedBank(name, icon, text) {
  const { questions, errors } = parseText(text);
  if (!questions.length) { toast('沒有讀到任何題目，格式可能不對'); return null; }
  let nm = name || '匯入的題庫', k = 2;
  while (state.banks.some((x) => x.name === nm)) nm = `${name}（${k++}）`;
  const b = { id: 'u' + uid(), name: nm, icon: icon || '📘', questions: [] };
  b.questions = assignIds(questions, [], b.id);
  state.banks.push(b);
  save();
  toast(`已匯入「${nm}」${questions.length} 題${errors.length ? `（${errors.length} 題格式不符略過）` : ''}`);
  return b;
}

async function handleShareHash() {
  const h = location.hash;
  if (!h.startsWith('#open=') && !h.startsWith('#import=')) return;
  history.replaceState(view, '', SHARE_BASE()); // 先清掉網址，避免重新整理又匯入一次
  if (h.startsWith('#open=')) {
    const id = decodeURIComponent(h.slice(6));
    if (getBank(id)) go('bank', { id }, { replace: true });
    else toast('找不到這個題庫，可能已更新，請按「檢查更新」');
    return;
  }
  try {
    const { n, i, t } = JSON.parse(await gunzipStr(b64u.dec(h.slice(8))));
    const cnt = parseText(t).questions.length;
    if (!confirm(`匯入同學分享的題庫？\n\n${i || '📘'} ${n}（${cnt} 題）\n\n會新增成一個新的題庫，不會動到你原本的資料。`)) return;
    const b = addImportedBank(n, i, t);
    if (b) go('bank', { id: b.id }, { replace: true });
  } catch {
    toast('分享連結壞掉了，可能沒有複製完整');
  }
}

Object.assign(ACTIONS, {
  'share-bank': async ({ id }) => {
    const b = getBank(id);
    if (!b) return;
    const url = await shareLink(b);
    if (url.length > 60000 && !confirm(`這個題庫很大（${b.questions.length} 題），連結會很長，有些聊天軟體可能貼不完整。\n仍要分享連結嗎？（也可以改用「⬇️ 匯出 .txt」傳檔案）`)) return;
    shareOut(`刷題本：${b.name}`, `一起來練「${b.name}」（${b.questions.length} 題）`, url);
  },
  'share-app': () => shareOut('刷題本', '高職段考刷題 App，手機打開就能練', SHARE_BASE()),
  'import-file': () => document.getElementById('importFile')?.click(),
});

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'importFile') return;
  const files = [...e.target.files];
  e.target.value = '';
  let last = null;
  for (const f of files) {
    const raw = await f.text();
    let name = f.name.replace(/\.(txt|md|json)$/i, ''), icon = '📘', text = raw;
    try { const j = JSON.parse(raw); if (j && typeof j.t === 'string') { name = j.n || name; icon = j.i || icon; text = j.t; } } catch { /* 純文字 */ }
    last = addImportedBank(name, icon, text) || last;
  }
  if (last) go('bank', { id: last.id });
});

window.addEventListener('hashchange', handleShareHash);
handleShareHash();
