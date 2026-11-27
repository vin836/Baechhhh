'use strict';

/* ============================================================
 * 刷題本：單機版測驗題庫（資料存在 localStorage）
 * ============================================================ */

const STORE_KEY = 'study-quiz-v1';
const BUILTIN = Array.isArray(window.BUILTIN_BANKS) ? window.BUILTIN_BANKS : [];
const LETTERS = 'ABCDEFGH';
const TYPE_LABEL = { single: '單選', multi: '多選', tf: '是非', fill: '填空' };
const CLEAR_STREAK = 2; // 錯題連續答對幾次後移出錯題本

const app = document.getElementById('app');

/* ---------- 小工具 ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const toHalf = (s) => String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
const normAns = (s) => toHalf(s).toLowerCase().replace(/\s+/g, '');
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

function download(filename, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
}

function fmtDate(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/* ---------- 資料 ---------- */

function defaultState() {
  return {
    banks: [],
    records: {},        // qid -> { seen, correct, streak, wrong, wrongCount, last }
    history: [],        // 每次測驗結果
    builtinVersions: {},
    settings: { count: 10, shuffleQ: true, shuffleOpt: true },
    current: null,      // 進行中的測驗（可中斷後繼續）
    lastResult: null,
  };
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.banks)) {
      const d = defaultState();
      return { ...d, ...s, settings: { ...d.settings, ...s.settings } };
    }
  } catch { /* 壞資料就重來 */ }
  return defaultState();
}

let state = load();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('儲存失敗，裝置空間可能不足');
  }
}

const getBank = (id) => state.banks.find((b) => b.id === id);
const rec = (id) => state.records[id];
const findQ = (bankId, qid) => getBank(bankId)?.questions.find((q) => q.id === qid);

function wrongList() {
  return state.banks.flatMap((b) => b.questions.filter((q) => rec(q.id)?.wrong).map((q) => ({ b, q })));
}

function bankStats(b) {
  let seen = 0, att = 0, cor = 0, wrong = 0;
  for (const q of b.questions) {
    const r = rec(q.id);
    if (!r) continue;
    if (r.seen) seen++;
    att += r.seen;
    cor += r.correct;
    if (r.wrong) wrong++;
  }
  return { total: b.questions.length, seen, att, cor, wrong };
}

function chaptersOf(b) {
  const m = new Map();
  for (const q of b.questions) m.set(q.chapter || '', (m.get(q.chapter || '') || 0) + 1);
  return [...m];
}

/* ---------- 文字格式解析 ---------- */

const RE_Q = /^(?:Q|題目?)\s*[:：]\s*(.*)$/i;
const RE_EXPLAIN = /^(?:解析|解|說明)\s*[:：]\s*(.*)$/;
const RE_ANS = /^(?:答案?|ANS)\s*[:：]\s*(.*)$/i;
const RE_OPT = /^[（(]?([A-HＡ-Ｈ])\s*[)）.、．:：]\s*(.*)$/;
const RE_STAR = /\s*[*＊]\s*$/;
const RE_TRUE = /^(O|○|〇|⭕|對|是|T|TRUE|正確)$/i;
const RE_FALSE = /^(X|×|✕|❌|錯|否|F|FALSE|錯誤)$/i;

function parseBlock(lines, chapter) {
  let q = '', explain = '', ans = null, mode = 'q';
  const opts = [], marks = [];

  for (const line of lines) {
    let m;
    if ((m = line.match(RE_Q))) { q = m[1]; mode = 'q'; }
    else if ((m = line.match(RE_EXPLAIN))) { explain = m[1]; mode = 'e'; }
    else if ((m = line.match(RE_ANS))) { ans = m[1].trim(); mode = 'a'; }
    else if ((m = line.match(RE_OPT)) && toHalf(m[1]).toUpperCase() === LETTERS[opts.length] && mode !== 'e') {
      let t = m[2];
      if (RE_STAR.test(t)) { marks.push(opts.length); t = t.replace(RE_STAR, ''); }
      opts.push(t.trim());
      mode = 'o';
    } else if (mode === 'e') explain += '\n' + line;
    else if (mode === 'o') opts[opts.length - 1] += ' ' + line;
    else if (mode === 'q') q = q ? `${q}\n${line}` : line;
  }

  q = q.trim();
  if (!q) return { error: '缺少題目文字' };
  const base = { q, explain: explain.trim(), chapter };

  if (opts.length) {
    if (opts.length < 2) return { error: '選項至少要 2 個' };
    let correct = marks;
    if (ans) {
      const letters = toHalf(ans).toUpperCase().match(/[A-H]/g) || [];
      correct = [...new Set(letters.map((l) => l.charCodeAt(0) - 65))];
    }
    if (!correct.length) return { error: '沒有標出正確答案（在選項後面加 *，或寫「答: B」）' };
    if (correct.some((i) => i >= opts.length)) return { error: '答案超出選項範圍' };
    correct.sort((a, b) => a - b);
    return correct.length > 1
      ? { q: { ...base, type: 'multi', options: opts, answer: correct } }
      : { q: { ...base, type: 'single', options: opts, answer: correct[0] } };
  }

  if (!ans) return { error: '缺少答案（選擇題要列出選項；是非、填空題要寫「答: …」）' };
  if (RE_TRUE.test(ans)) return { q: { ...base, type: 'tf', options: [], answer: 0 } };
  if (RE_FALSE.test(ans)) return { q: { ...base, type: 'tf', options: [], answer: 1 } };
  const answers = ans.split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
  if (!answers.length) return { error: '填空題答案是空的' };
  return { q: { ...base, type: 'fill', options: [], answer: answers } };
}

function parseText(text) {
  const questions = [], errors = [];
  let chapter = '', block = [], start = 0, no = 0;

  const flush = () => {
    if (!block.length) return;
    no++;
    const r = parseBlock(block, chapter);
    if (r.error) errors.push(`第 ${no} 題（第 ${start} 行）：${r.error}`);
    else questions.push(r.q);
    block = [];
  };

  text.replace(/\r/g, '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return flush();
    const ch = line.match(/^##\s*(.*)$/);
    if (ch) { flush(); chapter = ch[1].trim(); return; }
    if (RE_Q.test(line) && block.length) flush();
    if (!block.length) start = i + 1;
    block.push(line);
  });
  flush();
  return { questions, errors };
}

function questionToText(x) {
  const out = [`Q: ${x.q}`];
  if (x.type === 'single' || x.type === 'multi') {
    const ans = x.type === 'multi' ? x.answer : [x.answer];
    x.options.forEach((o, i) => out.push(`(${LETTERS[i]}) ${o}${ans.includes(i) ? ' *' : ''}`));
  } else if (x.type === 'tf') {
    out.push(`答: ${x.answer === 0 ? 'O' : 'X'}`);
  } else {
    out.push(`答: ${x.answer.join(' | ')}`);
  }
  if (x.explain) out.push(`解析: ${x.explain}`);
  return out.join('\n');
}

function bankToText(questions) {
  const parts = [];
  let chapter = '';
  for (const q of questions) {
    if ((q.chapter || '') !== chapter) {
      chapter = q.chapter || '';
      if (chapter) parts.push(`## ${chapter}`);
    }
    parts.push(questionToText(q));
  }
  return parts.join('\n\n') + '\n';
}

/** 依題目文字沿用舊 id，作答紀錄才不會因重新編輯而遺失 */
function assignIds(questions, oldQuestions, bankId) {
  const byText = new Map(oldQuestions.map((q) => [q.q, q.id]));
  const used = new Set();
  for (const q of questions) {
    let id = byText.get(q.q);
    if (!id || used.has(id)) {
      id = `${bankId}-${hash(q.q)}`;
      while (used.has(id)) id = `${bankId}-${hash(q.q + uid())}`;
    }
    q.id = id;
    used.add(id);
  }
  return questions;
}

function syncBuiltins() {
  for (const src of BUILTIN) {
    if ((state.builtinVersions[src.id] || 0) >= src.version) continue;
    const parsed = assignIds(parseText(src.text).questions, [], src.id);
    const have = getBank(src.id);
    if (!have) {
      const at = BUILTIN.indexOf(src);
      const bank = { id: src.id, name: src.name, icon: src.icon, group: src.group, builtin: true, questions: parsed };
      state.banks.splice(Math.min(at, state.banks.length), 0, bank);
    } else {
      if (src.group) have.group = src.group;
      // 同一題（id 相同）更新內容（例如新增詳解），作答紀錄不受影響；新題目加在後面
      const byId = new Map(have.questions.map((q) => [q.id, q]));
      for (const q of parsed) {
        if (byId.has(q.id)) Object.assign(byId.get(q.id), q);
        else have.questions.push(q);
      }
      // 內建題目依題庫檔的章節順序排列，自己加的題目保留在最後
      const order = new Map(parsed.map((q, i) => [q.id, i]));
      have.questions.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    }
    state.builtinVersions[src.id] = src.version;
  }
}

/* ---------- 導覽 ---------- */

let view = { name: 'home', params: {} };
let draft = null; // 單題編輯表單暫存
const VIEWS = {};
const AFTER = {};

function go(name, params = {}, { replace = false } = {}) {
  view = { name, params };
  history[replace ? 'replaceState' : 'pushState'](view, '');
  render();
  window.scrollTo(0, 0);
}

function rerender(params) {
  if (params) {
    view = { ...view, params: { ...view.params, ...params } };
    history.replaceState(view, '');
  }
  render();
}

window.addEventListener('popstate', (e) => {
  view = e.state || { name: 'home', params: {} };
  render();
});

const NAV_OF = { wrong: 'wrong', stats: 'stats' };

function render() {
  if (view.name !== 'qedit') draft = null;
  const fn = VIEWS[view.name] || VIEWS.home;
  app.innerHTML = fn(view.params || {});
  document.body.classList.toggle('in-quiz', view.name === 'quiz');
  const nav = NAV_OF[view.name] || 'home';
  document.querySelectorAll('.tabbar [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === nav));
  const n = wrongList().length;
  const badge = document.getElementById('wrongBadge');
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : n;
  AFTER[view.name]?.(view.params || {});
}

const notFound = () => `
  <div class="card empty"><div class="big">🤔</div><p>找不到這個頁面，可能已被刪除。</p>
  <button class="btn" data-nav="home">回題庫</button></div>`;

/* ---------- 首頁 ---------- */

const MAIN_GROUP = '我的題庫';

function bankGroups() {
  const groups = new Map();
  for (const b of state.banks) {
    const g = b.group || MAIN_GROUP;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(b);
  }
  const main = groups.get(MAIN_GROUP) || [];
  groups.delete(MAIN_GROUP);
  return [...groups, [MAIN_GROUP, main]]; // 段考等分區排在前面
}

VIEWS.home = () => {
  const wl = wrongList().length;
  const cur = state.current;
  return `
    ${cur ? `<button class="banner resume" data-action="resume">▶ 繼續上次的測驗：${esc(cur.title)}（${cur.idx}/${cur.items.length}）</button>` : ''}
    ${wl ? `<button class="banner" data-action="start-wrong">📕 錯題本有 ${wl} 題，來複習吧 →</button>` : ''}
    ${bankGroups().map(([g, banks]) => {
      const isMain = g === MAIN_GROUP;
      const mixable = isMain ? state.banks.length > 1 : banks.length > 1;
      return `
        <div class="section-head">
          <h2>${isMain ? '' : '🎯 '}${esc(g)}</h2>
          <div class="row">
            ${mixable ? `<button class="btn small" data-action="setup" data-id="${isMain ? 'all' : 'g:' + esc(g)}">🎲 ${isMain ? '全部綜合' : '混合練習'}</button>` : ''}
            ${isMain ? '<button class="btn small" data-action="new-bank">＋ 新增題庫</button>' : ''}
          </div>
        </div>
        <div class="bank-list">
          ${banks.map(bankCard).join('') || `
            <div class="card empty"><div class="big">📚</div><p>還沒有自己的題庫，按「新增題庫」開始吧！</p></div>`}
        </div>`;
    }).join('')}`;
};

function bankCard(b) {
  const s = bankStats(b);
  return `
    <div class="card bank-card">
      <div class="row"><span class="bank-ico">${esc(b.icon || '📘')}</span><h3 class="grow">${esc(b.name)}</h3></div>
      <div class="meta">
        <span><b>${s.total}</b> 題</span>
        <span>已練 <b>${s.seen}</b></span>
        <span>正確率 <b>${s.att ? pct(s.cor, s.att) + '%' : '—'}</b></span>
        ${s.wrong ? `<span class="bad">錯題 <b>${s.wrong}</b></span>` : ''}
      </div>
      <div class="meter" title="已練習比例"><i style="width:${pct(s.seen, s.total)}%"></i></div>
      <div class="row">
        <button class="btn primary grow" data-action="setup" data-id="${b.id}" ${s.total ? '' : 'disabled'}>開始練習</button>
        <button class="btn" data-action="open-bank" data-id="${b.id}">題目管理</button>
      </div>
    </div>`;
}

/* ---------- 題庫管理 ---------- */

VIEWS.bank = ({ id }) => {
  const b = getBank(id);
  if (!b) return notFound();
  const chs = chaptersOf(b);
  const hasChapters = chs.some(([c]) => c);
  return `
    <div class="section-head"><h1>${esc(b.icon || '📘')} ${esc(b.name)}</h1></div>
    <div class="row">
      <button class="btn primary" data-action="setup" data-id="${b.id}" ${b.questions.length ? '' : 'disabled'}>開始練習</button>
      <button class="btn" data-action="new-q" data-id="${b.id}">＋ 新增一題</button>
      <button class="btn" data-action="batch" data-id="${b.id}">📝 批次貼上／編輯</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn small ghost" data-action="rename-bank" data-id="${b.id}">✏️ 改名</button>
      <button class="btn small ghost" data-action="export-bank" data-id="${b.id}">⬇️ 匯出 .txt</button>
      <button class="btn small ghost danger" data-action="del-bank" data-id="${b.id}">🗑 刪除題庫</button>
    </div>
    ${hasChapters ? `
      <div class="section-head"><h2>依章節練習</h2></div>
      <div class="chips">
        ${chs.map(([c, n]) => `<button class="chip" data-action="setup" data-id="${b.id}" data-chapter="${esc(c)}">${esc(c || '未分章')} <span class="muted">${n}</span></button>`).join('')}
      </div>` : ''}
    <div class="section-head"><h2>全部題目（${b.questions.length}）</h2></div>
    ${b.questions.length ? '<input type="search" id="qsearch" placeholder="🔍 搜尋題目、選項或解析…" style="margin-bottom:10px">' : ''}
    <div class="card stack" id="qlist">${qListHTML(b, '')}</div>`;
};

function qListHTML(b, term) {
  const t = term.trim().toLowerCase();
  const list = t
    ? b.questions.filter((q) => [q.q, q.explain, ...(q.options || []), ...(q.type === 'fill' ? q.answer : [])].join(' ').toLowerCase().includes(t))
    : b.questions;
  if (!list.length) {
    return `<div class="empty">${t ? '找不到符合的題目' : '這個題庫還沒有題目。<br>可以「新增一題」，或用「批次貼上」一次加入很多題。'}</div>`;
  }
  let chapter = null;
  return list.map((q) => {
    let head = '';
    if ((q.chapter || '') !== chapter) {
      chapter = q.chapter || '';
      head = `<h3 class="ch-head">${esc(chapter || '未分章')}</h3>`;
    }
    const r = rec(q.id);
    return `${head}
      <div class="qitem">
        <div class="q">${esc(trunc(q.q, 90))}</div>
        <div class="foot">
          <span><span class="tag">${TYPE_LABEL[q.type]}</span>
            ${r ? `作答 ${r.seen} 次・答對 ${pct(r.correct, r.seen)}%` : '尚未練習'}${r?.wrong ? '・📕' : ''}</span>
          <span class="row" style="gap:2px">
            <button class="btn ghost small" data-action="edit-q" data-bank="${b.id}" data-id="${q.id}">編輯</button>
            <button class="btn ghost small danger" data-action="del-q" data-bank="${b.id}" data-id="${q.id}">刪除</button>
          </span>
        </div>
      </div>`;
  }).join('');
}

AFTER.bank = ({ id }) => {
  const input = document.getElementById('qsearch');
  const b = getBank(id);
  if (!input || !b) return;
  input.addEventListener('input', () => {
    document.getElementById('qlist').innerHTML = qListHTML(b, input.value);
  });
};

/* ---------- 批次文字編輯 ---------- */

const FORMAT_HELP = `## 第一章 直流電路        ← 章節（可省略）

Q: 1 kΩ 電阻流過 2 mA，兩端電壓為？
(A) 0.5 V
(B) 2 V *                ← 正確答案後面加 *
(C) 20 V
(D) 2000 V
解析: V = IR = 1k × 2m = 2 V

Q: 下列哪些是半導體材料？   ← 標兩個以上 * 就是多選題
(A) 矽 *
(B) 鍺 *
(C) 銅

Q: 理想運算放大器的輸入阻抗為無限大。
答: O                    ← 是非題寫 O 或 X

Q: (1010)₂ 等於十進位多少？
答: 10 | 十              ← 填空題，多個可接受答案用 | 分隔`;

VIEWS.batch = ({ id }) => {
  const b = getBank(id);
  if (!b) return notFound();
  return `
    <div class="section-head"><h1>📝 ${esc(b.name)}</h1></div>
    <div class="stack">
      <details class="help" ${b.questions.length ? '' : 'open'}>
        <summary>格式說明（題目之間空一行）</summary>
        <pre>${esc(FORMAT_HELP)}</pre>
        <p class="small muted">也可以把網路上或講義的題目整理成這個格式後貼上。儲存時會用題目文字比對，舊題目的作答紀錄會保留。</p>
      </details>
      <textarea id="batchText" spellcheck="false" placeholder="在這裡貼上題目…">${esc(b.questions.length ? bankToText(b.questions) : '')}</textarea>
      <div id="parseInfo" class="small"></div>
      <div class="row">
        <label class="btn small">📄 載入 .txt 檔<input type="file" accept=".txt,text/plain" id="txtFile" hidden></label>
        <span class="grow"></span>
        <button class="btn" data-action="back">取消</button>
        <button class="btn primary" data-action="save-batch" data-id="${b.id}">儲存</button>
      </div>
    </div>`;
};

function showParseInfo() {
  const ta = document.getElementById('batchText');
  const box = document.getElementById('parseInfo');
  if (!ta || !box) return;
  const { questions, errors } = parseText(ta.value);
  const counts = {};
  questions.forEach((q) => { counts[q.type] = (counts[q.type] || 0) + 1; });
  const detail = Object.entries(counts).map(([k, v]) => `${TYPE_LABEL[k]} ${v}`).join('、');
  box.innerHTML = `
    <div class="parse-ok">✓ 解析出 ${questions.length} 題${detail ? `（${detail}）` : ''}</div>
    ${errors.length ? `<div class="parse-err">⚠ ${errors.length} 題格式有誤，儲存時會略過：<ul>${errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('')}${errors.length > 8 ? '<li>…</li>' : ''}</ul></div>` : ''}`;
}

AFTER.batch = () => {
  const ta = document.getElementById('batchText');
  let timer;
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(showParseInfo, 250); });
  document.getElementById('txtFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n\n${text}` : text;
    showParseInfo();
    toast(`已載入 ${file.name}`);
  });
  showParseInfo();
};

/* ---------- 單題表單 ---------- */

function blankDraft(chapter = '') {
  return { type: 'single', q: '', options: ['', '', '', ''], answer: 0, explain: '', chapter };
}

VIEWS.qedit = ({ bank, id, chapter }) => {
  const b = getBank(bank);
  if (!b) return notFound();
  const key = `${bank}/${id || ''}`;
  if (!draft || draft._key !== key) {
    const q = id && findQ(bank, id);
    if (id && !q) return notFound();
    draft = q ? structuredClone(q) : blankDraft(chapter || '');
    if (draft.type === 'fill') draft.fillText = draft.answer.join(' | ');
    draft._key = key;
  }
  const d = draft;
  const chs = chaptersOf(b).map(([c]) => c).filter(Boolean);
  const isChoice = d.type === 'single' || d.type === 'multi';

  let answerPart = '';
  if (isChoice) {
    const ans = d.type === 'multi' ? d.answer : [d.answer];
    answerPart = `
      <div class="field">
        <span class="label">選項（${d.type === 'multi' ? '勾選所有正確答案' : '點左邊圓圈選正確答案'}）</span>
        ${d.options.map((o, i) => `
          <div class="opt-edit">
            <input type="${d.type === 'multi' ? 'checkbox' : 'radio'}" name="dans" value="${i}" ${ans.includes(i) ? 'checked' : ''} aria-label="把 ${LETTERS[i]} 設為正確答案">
            <span class="key">${LETTERS[i]}</span>
            <input type="text" data-opt="${i}" value="${esc(o)}" placeholder="選項 ${LETTERS[i]}">
            <button type="button" class="btn ghost small" data-action="del-opt" data-i="${i}" ${d.options.length <= 2 ? 'disabled' : ''} aria-label="刪除選項">✕</button>
          </div>`).join('')}
        ${d.options.length < 8 ? '<button type="button" class="btn small" data-action="add-opt">＋ 新增選項</button>' : ''}
      </div>`;
  } else if (d.type === 'tf') {
    answerPart = `
      <div class="field"><span class="label">正確答案</span>
        <div class="seg">
          <label><input type="radio" name="dans" value="0" ${d.answer === 0 ? 'checked' : ''}> ⭕ 正確（O）</label>
          <label><input type="radio" name="dans" value="1" ${d.answer === 1 ? 'checked' : ''}> ❌ 錯誤（X）</label>
        </div>
      </div>`;
  } else {
    answerPart = `
      <div class="field"><label for="dfill">正確答案</label>
        <input type="text" id="dfill" value="${esc(d.fillText || '')}" placeholder="例如：10 | 十">
        <span class="small muted">有多種寫法都算對時，用 | 分隔。比對時會忽略空白、大小寫與全形半形。</span>
      </div>`;
  }

  return `
    <div class="section-head"><h1>${id ? '編輯題目' : '新增題目'}</h1><span class="muted small">${esc(b.name)}</span></div>
    <form class="card stack" id="qform" autocomplete="off">
      <div class="field"><span class="label">題型</span>
        <div class="seg">
          ${Object.entries(TYPE_LABEL).map(([k, l]) => `<label><input type="radio" name="dtype" value="${k}" ${d.type === k ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>
      </div>
      <div class="field"><label for="dch">章節（可留空）</label>
        <input type="text" id="dch" list="chlist" value="${esc(d.chapter || '')}" placeholder="例如：第三章 交流電路">
        <datalist id="chlist">${chs.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      </div>
      <div class="field"><label for="dq">題目</label>
        <textarea id="dq" class="short" placeholder="輸入題目內容">${esc(d.q)}</textarea>
      </div>
      ${answerPart}
      <div class="field"><label for="dexp">解析（可留空）</label>
        <textarea id="dexp" class="short" placeholder="答錯時會顯示，寫下解題關鍵">${esc(d.explain || '')}</textarea>
      </div>
      <div class="row end">
        <button type="button" class="btn" data-action="back">取消</button>
        ${id ? '' : '<button type="button" class="btn" data-action="save-q" data-next="1">儲存並繼續新增</button>'}
        <button type="button" class="btn primary" data-action="save-q">儲存</button>
      </div>
    </form>`;
};

function collectDraft() {
  const d = draft;
  const f = document.getElementById('qform');
  if (!d || !f) return;
  d.chapter = f.querySelector('#dch').value.trim();
  d.q = f.querySelector('#dq').value;
  d.explain = f.querySelector('#dexp').value;
  const checked = [...f.querySelectorAll('input[name="dans"]:checked')].map((x) => Number(x.value));
  if (d.type === 'single' || d.type === 'multi') {
    d.options = [...f.querySelectorAll('[data-opt]')].map((x) => x.value);
    d.answer = d.type === 'multi' ? checked : (checked[0] ?? -1);
  } else if (d.type === 'tf') {
    d.answer = checked[0] ?? -1;
  } else {
    d.fillText = f.querySelector('#dfill').value;
  }
}

function changeDraftType(type) {
  collectDraft();
  const d = draft;
  const prev = d.type;
  d.type = type;
  if (type === 'single' || type === 'multi') {
    if (!d.options || d.options.length < 2) d.options = ['', '', '', ''];
    if (type === 'multi') d.answer = prev === 'single' && d.answer >= 0 ? [d.answer] : prev === 'multi' ? d.answer : [];
    else d.answer = prev === 'multi' ? (d.answer[0] ?? 0) : prev === 'single' ? d.answer : 0;
  } else if (type === 'tf') {
    d.answer = 0;
  } else {
    d.fillText = d.fillText || '';
  }
  render();
}

AFTER.qedit = () => {
  const f = document.getElementById('qform');
  if (!f) return;
  f.addEventListener('change', (e) => {
    if (e.target.name === 'dtype') changeDraftType(e.target.value);
  });
};

function buildQuestionFromDraft() {
  const d = draft;
  const q = d.q.trim();
  if (!q) return { error: '請輸入題目' };
  const base = { q, explain: d.explain.trim(), chapter: d.chapter };

  if (d.type === 'single' || d.type === 'multi') {
    const keep = [];
    d.options.forEach((o, i) => { if (o.trim()) keep.push(i); });
    if (keep.length < 2) return { error: '至少要填 2 個選項' };
    const remap = (i) => keep.indexOf(i);
    const options = keep.map((i) => d.options[i].trim());
    if (d.type === 'single') {
      const a = remap(d.answer);
      if (a < 0) return { error: '請選擇正確答案（且該選項不能是空的）' };
      return { q: { ...base, type: 'single', options, answer: a } };
    }
    const a = d.answer.map(remap).filter((i) => i >= 0).sort((x, y) => x - y);
    if (!a.length) return { error: '請至少勾選一個正確答案' };
    return { q: { ...base, type: a.length > 1 ? 'multi' : 'single', options, answer: a.length > 1 ? a : a[0] } };
  }
  if (d.type === 'tf') {
    if (d.answer !== 0 && d.answer !== 1) return { error: '請選擇正確答案' };
    return { q: { ...base, type: 'tf', options: [], answer: d.answer } };
  }
  const answers = (d.fillText || '').split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
  if (!answers.length) return { error: '請輸入填空題的正確答案' };
  return { q: { ...base, type: 'fill', options: [], answer: answers } };
}

/* ---------- 測驗設定 ---------- */

function banksFor(id) {
  if (id === 'all') return state.banks;
  if (id?.startsWith('g:')) return state.banks.filter((b) => b.group === id.slice(2));
  return [getBank(id)].filter(Boolean);
}

function buildPool({ id, chapter = '', mode = 'all' }) {
  const banks = banksFor(id);
  let pool = banks.flatMap((b) => b.questions.map((q) => ({ b, q })));
  if (chapter) pool = pool.filter((x) => (x.q.chapter || '') === chapter);
  if (mode === 'wrong') pool = pool.filter((x) => rec(x.q.id)?.wrong);
  if (mode === 'new') pool = pool.filter((x) => !rec(x.q.id)?.seen);
  return pool;
}

VIEWS.setup = ({ id, chapter = '', mode = 'all' }) => {
  const b = getBank(id);
  if (!b && !banksFor(id).length) return notFound();
  const title = b ? b.name : id === 'all' ? '綜合練習（全部題庫）' : `${id.slice(2)}・混合練習`;
  const counts = {
    all: buildPool({ id, chapter, mode: 'all' }).length,
    new: buildPool({ id, chapter, mode: 'new' }).length,
    wrong: buildPool({ id, chapter, mode: 'wrong' }).length,
  };
  if (!counts[mode]) mode = 'all';
  const st = state.settings;
  const chs = b ? chaptersOf(b).filter(([c]) => c) : [];
  const n = st.count ? Math.min(st.count, counts[mode]) : counts[mode];

  return `
    <div class="section-head"><h1>${esc(b?.icon || '🎲')} ${esc(title)}</h1></div>
    <form class="card stack" id="setupForm">
      ${chs.length ? `
        <div class="field"><label for="chapter">範圍</label>
          <select id="chapter" name="chapter">
            <option value="">全部章節</option>
            ${chs.map(([c, k]) => `<option value="${esc(c)}" ${c === chapter ? 'selected' : ''}>${esc(c)}（${k}）</option>`).join('')}
          </select>
        </div>` : ''}
      <div class="field"><span class="label">出題方式</span>
        <div class="seg">
          ${[['all', '全部'], ['new', '沒做過的'], ['wrong', '只練錯題']].map(([v, l]) => `
            <label><input type="radio" name="mode" value="${v}" ${mode === v ? 'checked' : ''} ${counts[v] ? '' : 'disabled'}> ${l}（${counts[v]}）</label>`).join('')}
        </div>
      </div>
      <div class="field"><span class="label">題數</span>
        <div class="seg">
          ${[5, 10, 20, 50, 0].map((k) => `<label><input type="radio" name="count" value="${k}" ${st.count === k ? 'checked' : ''}> ${k || '全部'}</label>`).join('')}
        </div>
      </div>
      <label class="check"><input type="checkbox" name="shuffleQ" ${st.shuffleQ ? 'checked' : ''}> 題目順序隨機</label>
      <label class="check"><input type="checkbox" name="shuffleOpt" ${st.shuffleOpt ? 'checked' : ''}> 選項順序隨機（含「以上皆是」的題目不會打亂）</label>
      <button class="btn primary block" type="submit" ${counts[mode] ? '' : 'disabled'}>開始測驗（${n} 題）</button>
    </form>`;
};

AFTER.setup = ({ id }) => {
  const f = document.getElementById('setupForm');
  if (!f) return;
  const read = () => {
    const fd = new FormData(f);
    state.settings.count = Number(fd.get('count'));
    state.settings.shuffleQ = fd.has('shuffleQ');
    state.settings.shuffleOpt = fd.has('shuffleOpt');
    save();
    return { chapter: fd.get('chapter') || '', mode: fd.get('mode') || 'all' };
  };
  f.addEventListener('change', () => rerender(read()));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const { chapter, mode } = read();
    const b = getBank(id);
    const name = b ? b.name : id === 'all' ? '綜合練習' : `${id.slice(2)}・混合`;
    const modeName = { all: '', new: '・新題', wrong: '・錯題' }[mode];
    startQuiz({ id, chapter, mode, title: `${name}${chapter ? '・' + chapter : ''}${modeName}` });
  });
};

/* ---------- 測驗 ---------- */

const NO_SHUFFLE = /以上|皆非|皆是|皆對|皆錯|都對|都不對|all of the above|none of the above/i;

function optionOrder(q, shuffleOn) {
  if (q.type !== 'single' && q.type !== 'multi') return [];
  const idx = q.options.map((_, i) => i);
  return shuffleOn && !q.options.some((o) => NO_SHUFFLE.test(o)) ? shuffle(idx) : idx;
}

function startQuiz({ id = 'all', chapter = '', mode = 'all', ids = null, title }) {
  let pool = ids
    ? ids.map(([bid, qid]) => ({ b: getBank(bid), q: findQ(bid, qid) })).filter((x) => x.q)
    : buildPool({ id, chapter, mode });
  if (!pool.length) { toast('沒有可出的題目'); return; }
  const st = state.settings;
  if (st.shuffleQ) pool = shuffle(pool);
  if (!ids && st.count) pool = pool.slice(0, st.count);
  state.current = {
    title: title || '練習',
    multiBank: new Set(pool.map((x) => x.b.id)).size > 1,
    start: Date.now(),
    idx: 0,
    items: pool.map(({ b, q }) => ({ b: b.id, q: q.id, order: optionOrder(q, st.shuffleOpt), picks: [], answer: null, ok: null, cleared: false })),
  };
  save();
  go('quiz', {}, { replace: view.name === 'setup' || view.name === 'result' });
}

function record(id, ok) {
  const r = (state.records[id] ||= { seen: 0, correct: 0, streak: 0, wrong: false, wrongCount: 0 });
  r.seen++;
  r.last = Date.now();
  if (ok) {
    r.correct++;
    r.streak++;
    if (r.wrong && r.streak >= CLEAR_STREAK) { r.wrong = false; return true; }
  } else {
    r.streak = 0;
    r.wrong = true;
    r.wrongCount = (r.wrongCount || 0) + 1;
  }
  return false;
}

function isCorrect(q, value) {
  if (q.type === 'multi') {
    const a = [...value].sort((x, y) => x - y);
    return a.length === q.answer.length && a.every((v, i) => v === q.answer[i]);
  }
  if (q.type === 'fill') return q.answer.some((a) => normAns(a) === normAns(value));
  return value === q.answer;
}

function submitAnswer(value) {
  const cur = state.current;
  const it = cur?.items[cur.idx];
  if (!it || it.answer !== null) return;
  const q = findQ(it.b, it.q);
  if (!q) return;
  it.answer = value;
  it.ok = isCorrect(q, value);
  it.cleared = record(q.id, it.ok);
  if (!it.ok) navigator.vibrate?.(60);
  save();
  render();
}

/** 用文字描述某個答案（結果頁、錯題本用） */
function answerText(q, value) {
  if (q.type === 'single') return q.options[value] ?? '';
  if (q.type === 'multi') return value.map((i) => q.options[i]).join('、');
  if (q.type === 'tf') return value === 0 ? '⭕ 正確' : '❌ 錯誤';
  return Array.isArray(value) ? value.join(' 或 ') : value;
}

function correctTextInQuiz(q, it) {
  if (q.type === 'single' || q.type === 'multi') {
    const ans = q.type === 'multi' ? q.answer : [q.answer];
    return ans
      .map((oi) => [it.order.indexOf(oi), oi])
      .sort((a, b) => a[0] - b[0])
      .map(([di, oi]) => `(${LETTERS[di]}) ${q.options[oi]}`)
      .join('、');
  }
  return answerText(q, q.answer);
}

/* ---------- 計算白板 ---------- */

const NUMERIC_OPT = /^[\s(（]*[−\-+]?[\d√π(]/;
const CALC_RE = /\d\s*[×÷*/+\-−]\s*[\d(√]|[=＝]\s*[−\-]?\d/;

/** 判斷是不是需要計算的題目：選項多半是數字，或解析裡有算式 */
function needsBoard(q) {
  if (q.type === 'tf') return false;
  const opts = q.options || [];
  // 選項是數字「而且」題目本身有給數據，才算計算題（排除「A 類導通角為？」這類背誦題）
  if (/\d|承上題/.test(q.q) && opts.length && opts.filter((o) => NUMERIC_OPT.test(o)).length * 2 >= opts.length) return true;
  if (q.type === 'fill' && q.answer.some((a) => NUMERIC_OPT.test(a)) && /\d/.test(q.q)) return true;
  return /\d/.test(q.q) && CALC_RE.test(q.explain || '');
}

const board = { el: null, canvas: null, ctx: null, strokes: [], cur: null, key: null, open: null, tool: 'pen', color: 'ink', tall: false };

function syncBoardKey() {
  const cur = state.current;
  const key = cur ? `${cur.start}:${cur.idx}` : null;
  if (board.key !== key) {
    board.key = key;
    board.strokes = [];
    board.open = null;
    board.cur = null;
    if (board.ctx) redrawBoard();
  }
}

function inkColor(c) {
  return c === 'ink' ? getComputedStyle(document.body).color : c;
}

function strokeStyle(ctx, s) {
  ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = s.tool === 'eraser' ? '#000' : inkColor(s.color);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = s.tool === 'eraser' ? 24 : 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function drawSegment(s, from) {
  const { ctx } = board;
  strokeStyle(ctx, s);
  const p = s.pts;
  if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(p[Math.max(from - 1, 0)][0], p[Math.max(from - 1, 0)][1]);
  for (let i = from; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
  ctx.stroke();
}

function redrawBoard() {
  const { canvas, ctx } = board;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (const s of board.strokes) drawSegment(s, 1);
}

function updateBoardBar() {
  board.el.querySelectorAll('[data-tool]').forEach((b) => {
    const active = b.dataset.tool === board.tool && (b.dataset.tool === 'eraser' || b.dataset.color === board.color);
    b.classList.toggle('active', active);
  });
  board.el.classList.toggle('tall', board.tall);
  board.el.querySelector('[data-board="size"]').textContent = board.tall ? '⤡ 縮小' : '⤢ 放大';
}

function ensureBoard() {
  if (board.el) return board.el;
  const el = document.createElement('div');
  el.className = 'board';
  el.innerHTML = `
    <div class="board-bar">
      <button type="button" data-tool="pen" data-color="ink" aria-label="黑筆"><i class="dot" style="background:var(--text)"></i></button>
      <button type="button" data-tool="pen" data-color="#e11d48" aria-label="紅筆"><i class="dot" style="background:#e11d48"></i></button>
      <button type="button" data-tool="pen" data-color="#2563eb" aria-label="藍筆"><i class="dot" style="background:#2563eb"></i></button>
      <button type="button" data-tool="eraser" aria-label="橡皮擦">🧽</button>
      <span class="grow"></span>
      <button type="button" data-board="undo" aria-label="復原">↶</button>
      <button type="button" data-board="clear" aria-label="清除">🗑</button>
      <button type="button" data-board="size">⤢ 放大</button>
    </div>
    <canvas aria-label="計算白板，可用手指或滑鼠書寫"></canvas>`;
  const canvas = el.querySelector('canvas');
  board.el = el;
  board.canvas = canvas;
  board.ctx = canvas.getContext('2d');

  el.querySelector('.board-bar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) {
      board.tool = b.dataset.tool;
      if (b.dataset.color) board.color = b.dataset.color;
    } else if (b.dataset.board === 'undo') {
      board.strokes.pop();
      redrawBoard();
    } else if (b.dataset.board === 'clear') {
      board.strokes = [];
      redrawBoard();
    } else if (b.dataset.board === 'size') {
      board.tall = !board.tall;
      requestAnimationFrame(redrawBoard);
    }
    updateBoardBar();
  });

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    board.cur = { tool: board.tool, color: board.color, pts: [pos(e)] };
    board.strokes.push(board.cur);
    drawSegment(board.cur, 0);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!board.cur) return;
    e.preventDefault();
    const from = board.cur.pts.length;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) board.cur.pts.push(pos(ev));
    drawSegment(board.cur, from);
  });
  const end = () => { board.cur = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  new ResizeObserver(() => redrawBoard()).observe(canvas);
  updateBoardBar();
  return el;
}

VIEWS.quiz = () => {
  const cur = state.current;
  if (!cur) return notFound();
  const it = cur.items[cur.idx];
  const q = findQ(it.b, it.q);
  const answered = it.answer !== null;
  const last = cur.idx === cur.items.length - 1;

  const head = `
    <div class="quiz-head">
      <button class="btn ghost small" data-action="quit" aria-label="結束測驗">✕</button>
      <div class="progress"><i style="width:${pct(cur.idx + (answered ? 1 : 0), cur.items.length)}%"></i></div>
      <span class="small muted">${cur.idx + 1} / ${cur.items.length}</span>
    </div>`;

  if (!q) {
    return `${head}<div class="card empty"><p>這題已經被刪除了。</p>
      <button class="btn primary" data-action="next">${last ? '看結果' : '跳過 →'}</button></div>`;
  }

  const bank = getBank(it.b);
  const tags = [
    cur.multiBank ? bank?.name : '',
    q.chapter,
    TYPE_LABEL[q.type],
  ].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ');

  let body = '';
  if (q.type === 'single' || q.type === 'multi') {
    const ans = q.type === 'multi' ? q.answer : [q.answer];
    const chosenSet = answered ? (q.type === 'multi' ? it.answer : [it.answer]) : it.picks;
    body = `<div class="options">${it.order.map((oi, di) => {
      const isAns = ans.includes(oi);
      const chosen = chosenSet.includes(oi);
      let cls = 'opt';
      if (answered) cls += isAns ? ' correct' : chosen ? ' wrong' : ' dim';
      else if (chosen) cls += ' selected';
      return `<button class="${cls}" data-action="${q.type === 'multi' ? 'toggle' : 'pick'}" data-i="${oi}" ${answered ? 'disabled' : ''}>
        <span class="key">${LETTERS[di]}</span><span>${esc(q.options[oi])}</span></button>`;
    }).join('')}</div>`;
    if (q.type === 'multi' && !answered) {
      body += `<p class="small muted center">多選題：選出所有正確答案後按確認</p>
        <button class="btn primary block" data-action="submit-multi" ${it.picks.length ? '' : 'disabled'}>確認答案</button>`;
    }
  } else if (q.type === 'tf') {
    body = `<div class="options tf">${[['⭕', '正確'], ['❌', '錯誤']].map(([icon, label], i) => {
      let cls = 'opt';
      if (answered) cls += q.answer === i ? ' correct' : it.answer === i ? ' wrong' : ' dim';
      return `<button class="${cls}" data-action="pick" data-i="${i}" ${answered ? 'disabled' : ''}>${icon} ${label}</button>`;
    }).join('')}</div>`;
  } else if (!answered) {
    body = `<form id="fillForm" class="row">
      <input type="text" id="fillInput" class="grow" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="輸入你的答案" enterkeyhint="done">
      <button class="btn primary">確認</button></form>`;
  } else {
    body = `<div class="opt ${it.ok ? 'correct' : 'wrong'}"><span>你的答案：${esc(it.answer)}</span></div>`;
  }

  let feedback = '';
  if (answered) {
    feedback = `
      <div class="feedback ${it.ok ? 'ok' : 'bad'}">
        <div class="title">${it.ok ? '✓ 答對了！' : '✗ 答錯了'}</div>
        ${it.ok ? '' : `<div>正確答案：${esc(correctTextInQuiz(q, it))}</div>`}
        ${it.cleared ? `<div>🎉 已連續答對 ${CLEAR_STREAK} 次，移出錯題本</div>` : ''}
        ${q.explain ? `<div class="explain">💡 ${esc(q.explain)}</div>` : ''}
      </div>
      <div class="next-bar"><button class="btn primary block" data-action="next">${last ? '看結果 🏁' : '下一題 →'}</button></div>`;
  }

  syncBoardKey();
  const boardOpen = board.open ?? needsBoard(q);

  return `${head}
    <div>${tags}</div>
    <div class="question">${esc(q.q)}</div>
    <div id="boardSlot"></div>
    <div class="row end board-row">
      <button class="btn ghost small" data-action="toggle-board">${boardOpen ? '收起白板' : '✏️ 白板'}</button>
    </div>
    ${body}
    ${feedback}
    <div class="kbd-hint">鍵盤：數字鍵選答案，Enter 下一題</div>`;
};

AFTER.quiz = () => {
  const cur = state.current;
  const it = cur?.items[cur.idx];
  const q = it && findQ(it.b, it.q);
  const slot = document.getElementById('boardSlot');
  if (slot && q && (board.open ?? needsBoard(q))) {
    slot.append(ensureBoard());
    requestAnimationFrame(redrawBoard);
  }

  const form = document.getElementById('fillForm');
  if (form) {
    const input = document.getElementById('fillInput');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) submitAnswer(input.value.trim());
    });
    // 手機上自動跳出鍵盤會擋住白板，只在有實體鍵盤的裝置自動聚焦
    if (matchMedia('(hover: hover)').matches) input.focus();
  }
  const fb = app.querySelector('.feedback');
  if (fb) fb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

function nextQuestion() {
  const cur = state.current;
  if (!cur) return;
  if (cur.idx >= cur.items.length - 1) return finishQuiz();
  cur.idx++;
  save();
  render();
  window.scrollTo(0, 0);
}

function finishQuiz() {
  const cur = state.current;
  if (!cur) return;
  const done = cur.items.filter((i) => i.answer !== null);
  state.current = null;
  if (!done.length) { save(); go('home', {}, { replace: true }); return; }
  const correct = done.filter((i) => i.ok).length;
  const result = {
    t: Date.now(),
    title: cur.title,
    total: done.length,
    correct,
    dur: Date.now() - cur.start,
  };
  state.history.unshift(result);
  if (state.history.length > 300) state.history.length = 300;
  state.lastResult = { ...result, wrong: done.filter((i) => !i.ok).map((i) => [i.b, i.q, i.answer]) };
  save();
  go('result', {}, { replace: true });
}

/* ---------- 結果 ---------- */

VIEWS.result = () => {
  const r = state.lastResult;
  if (!r) return notFound();
  const p = pct(r.correct, r.total);
  const msg = p === 100 ? '全對！太強了 🎉' : p >= 80 ? '表現很好 👍' : p >= 60 ? '及格了，再加把勁 💪' : '多練幾次一定會進步 📖';
  const wrongItems = r.wrong.map(([b, qid, a]) => ({ q: findQ(b, qid), a })).filter((x) => x.q);
  return `
    <div class="card center stack">
      <div class="score" style="--p:${p}"><div><strong>${p}</strong><span class="small muted">分</span></div></div>
      <h2>${msg}</h2>
      <p class="muted">${esc(r.title)}<br>答對 ${r.correct} / ${r.total} 題・用時 ${fmtDuration(r.dur)}</p>
      <div class="row" style="justify-content:center">
        ${wrongItems.length ? `<button class="btn primary" data-action="retry-wrong">🔁 重練這 ${wrongItems.length} 題</button>` : ''}
        <button class="btn" data-nav="home">回題庫</button>
      </div>
    </div>
    ${wrongItems.length ? `
      <div class="section-head"><h2>這次答錯的題目</h2></div>
      <div class="card stack">
        ${wrongItems.map(({ q, a }) => `
          <div class="qitem">
            <div class="q">${esc(q.q)}</div>
            <div class="yours small">你的答案：${esc(answerText(q, a))}</div>
            <div class="ans">正確答案：${esc(answerText(q, q.answer))}</div>
            ${q.explain ? `<div class="explain">💡 ${esc(q.explain)}</div>` : ''}
          </div>`).join('')}
      </div>` : ''}`;
};

/* ---------- 錯題本 ---------- */

VIEWS.wrong = () => {
  const list = wrongList();
  if (!list.length) {
    return `<div class="section-head"><h1>📕 錯題本</h1></div>
      <div class="card empty"><div class="big">🎉</div>
      <p>目前沒有錯題！<br>答錯的題目會自動收進這裡，<br>之後連續答對 ${CLEAR_STREAK} 次就會移出。</p></div>`;
  }
  const groups = new Map();
  for (const x of list) {
    if (!groups.has(x.b.id)) groups.set(x.b.id, []);
    groups.get(x.b.id).push(x);
  }
  return `
    <div class="section-head"><h1>📕 錯題本</h1></div>
    <button class="btn primary block" data-action="start-wrong">全部錯題一起練（${list.length} 題）</button>
    <p class="small muted">答錯會自動收錄，連續答對 ${CLEAR_STREAK} 次自動移出。</p>
    ${[...groups.values()].map((items) => {
      const b = items[0].b;
      return `
        <div class="section-head"><h2>${esc(b.icon || '📘')} ${esc(b.name)}（${items.length}）</h2>
          <button class="btn small" data-action="start-wrong" data-id="${b.id}">練這科</button></div>
        <div class="card stack">
          ${items.map(({ q }) => {
            const r = rec(q.id);
            return `
              <div class="qitem">
                <div class="q">${esc(q.q)}</div>
                <div class="ans">✓ ${esc(answerText(q, q.answer))}</div>
                ${q.explain ? `<div class="explain">💡 ${esc(q.explain)}</div>` : ''}
                <div class="foot">
                  <span>錯 ${r.wrongCount || 1} 次・連續答對 ${r.streak}/${CLEAR_STREAK}</span>
                  <button class="btn ghost small" data-action="unwrong" data-id="${q.id}">我會了，移出</button>
                </div>
              </div>`;
          }).join('')}
        </div>`;
    }).join('')}`;
};

/* ---------- 統計 ---------- */

function practiceStreak() {
  const days = new Set(state.history.map((h) => dayKey(h.t)));
  let n = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // 今天還沒練不算中斷
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

VIEWS.stats = () => {
  let att = 0, cor = 0;
  for (const b of state.banks) { const s = bankStats(b); att += s.att; cor += s.cor; }
  const today = dayKey(Date.now());
  const todayCount = state.history.filter((h) => dayKey(h.t) === today).reduce((s, h) => s + h.total, 0);
  const totalTime = state.history.reduce((s, h) => s + h.dur, 0);
  const banksWithData = state.banks.map((b) => ({ b, s: bankStats(b) }));

  return `
    <div class="section-head"><h1>📈 學習統計</h1></div>
    <div class="stat-grid">
      <div class="card stat"><div class="v">${todayCount}</div><div class="k">今天作答題數</div></div>
      <div class="card stat"><div class="v">${practiceStreak()} 天</div><div class="k">連續練習</div></div>
      <div class="card stat"><div class="v">${att ? pct(cor, att) + '%' : '—'}</div><div class="k">整體正確率（${att} 題次）</div></div>
      <div class="card stat"><div class="v">${fmtDuration(totalTime).replace(/ \d+ 秒$/, '')}</div><div class="k">累計練習時間</div></div>
    </div>

    <div class="section-head"><h2>各科正確率</h2></div>
    <div class="card">
      ${banksWithData.length ? banksWithData.map(({ b, s }) => `
        <div class="bar-row">
          <span class="name">${esc(b.icon || '📘')} ${esc(b.name)}</span>
          <div class="meter" style="margin:0"><i style="width:${pct(s.cor, s.att)}%;${s.att && pct(s.cor, s.att) < 60 ? 'background:var(--bad)' : ''}"></i></div>
          <span class="pct">${s.att ? pct(s.cor, s.att) + '%' : '—'}</span>
        </div>
        <div class="small muted" style="margin:2px 0 10px">已練 ${s.seen}/${s.total} 題${s.wrong ? `・錯題 ${s.wrong}` : ''}</div>`).join('') : '<p class="muted">還沒有題庫</p>'}
    </div>

    <div class="section-head"><h2>最近的測驗</h2></div>
    <div class="card">
      ${state.history.length ? `<table class="hist"><tbody>
        ${state.history.slice(0, 15).map((h) => `<tr><td class="muted">${fmtDate(h.t)}</td><td>${esc(h.title)}</td><td>${h.correct}/${h.total}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">還沒有測驗紀錄，去練一回吧！</p>'}
    </div>

    <div class="section-head"><h2>資料管理</h2></div>
    <div class="card stack">
      <p class="small muted">所有資料只存在這支手機的瀏覽器裡。換手機或清除瀏覽資料前，請先「匯出備份」。</p>
      <div class="row">
        <button class="btn small" data-action="export-all">⬇️ 匯出備份</button>
        <label class="btn small">⬆️ 匯入備份<input type="file" accept=".json,application/json" id="importFile" hidden></label>
        <button class="btn small" data-action="restore-builtin">♻️ 補回內建題庫</button>
        <button class="btn small" data-action="check-update">🔄 檢查更新</button>
      </div>
      <div class="row">
        <button class="btn small danger" data-action="clear-records">清除作答紀錄</button>
        <button class="btn small danger" data-action="reset-all">全部重置</button>
      </div>
    </div>
    <p class="small muted center" style="margin-top:20px">
      💡 iPhone：Safari 分享 →「加入主畫面」；Android：Chrome 選單 →「安裝應用程式」，之後沒網路也能用。
      <br>目前共 ${state.banks.length} 個題庫、${state.banks.reduce((s, b) => s + b.questions.length, 0)} 題
    </p>`;
};

AFTER.stats = () => {
  document.getElementById('importFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.banks)) throw new Error('bad');
      if (!confirm(`要用「${file.name}」覆蓋目前所有資料嗎？\n（題庫 ${data.banks.length} 個）`)) return;
      const d = defaultState();
      state = { ...d, ...data, settings: { ...d.settings, ...data.settings } };
      save();
      toast('匯入完成');
      render();
    } catch {
      toast('這不是有效的備份檔');
    }
  });
};

/* ---------- 動作 ---------- */

const ACTIONS = {
  back: () => history.back(),
  resume: () => go('quiz'),
  setup: ({ id, chapter }) => go('setup', { id, chapter: chapter || '' }),
  'open-bank': ({ id }) => go('bank', { id }),
  batch: ({ id }) => go('batch', { id }),
  'new-q': ({ id }) => go('qedit', { bank: id }),
  'edit-q': ({ bank, id }) => go('qedit', { bank, id }),

  'start-wrong': ({ id }) => {
    const list = wrongList().filter((x) => !id || x.b.id === id);
    const name = id ? getBank(id)?.name : '全部';
    startQuiz({ ids: list.map((x) => [x.b.id, x.q.id]), title: `錯題複習・${name}` });
  },
  'retry-wrong': () => {
    const r = state.lastResult;
    startQuiz({ ids: r.wrong.map(([b, q]) => [b, q]), title: `重練錯題・${r.title}` });
  },

  pick: ({ i }) => submitAnswer(Number(i)),
  toggle: ({ i }) => {
    const it = state.current.items[state.current.idx];
    const n = Number(i);
    it.picks = it.picks.includes(n) ? it.picks.filter((x) => x !== n) : [...it.picks, n];
    save();
    render();
  },
  'submit-multi': () => {
    const it = state.current.items[state.current.idx];
    if (it.picks.length) submitAnswer([...it.picks]);
  },
  next: nextQuestion,
  'toggle-board': () => {
    const it = state.current.items[state.current.idx];
    const q = findQ(it.b, it.q);
    board.open = !(board.open ?? needsBoard(q));
    render();
  },
  quit: () => {
    const cur = state.current;
    const done = cur.items.filter((i) => i.answer !== null).length;
    if (!done) {
      if (confirm('要離開這次測驗嗎？')) { state.current = null; save(); go('home', {}, { replace: true }); }
      return;
    }
    if (confirm(`已作答 ${done} 題，要結束並看結果嗎？\n\n（按「取消」繼續作答；想暫停可點左上角 Logo，之後從首頁繼續）`)) finishQuiz();
  },

  unwrong: ({ id }) => {
    const r = rec(id);
    if (r) { r.wrong = false; r.streak = 0; save(); render(); toast('已移出錯題本'); }
  },

  'new-bank': () => {
    const name = prompt('新題庫的名稱：', '');
    if (!name?.trim()) return;
    const b = { id: 'u' + uid(), name: name.trim(), icon: '📘', questions: [] };
    state.banks.push(b);
    save();
    go('bank', { id: b.id });
  },
  'rename-bank': ({ id }) => {
    const b = getBank(id);
    const name = prompt('題庫名稱：', b.name);
    if (!name?.trim()) return;
    b.name = name.trim();
    save();
    render();
  },
  'del-bank': ({ id }) => {
    const b = getBank(id);
    if (!confirm(`確定刪除「${b.name}」？\n裡面的 ${b.questions.length} 題和作答紀錄都會刪除，無法復原。`)) return;
    b.questions.forEach((q) => delete state.records[q.id]);
    state.banks = state.banks.filter((x) => x !== b);
    save();
    go('home', {}, { replace: true });
    toast('已刪除題庫');
  },
  'export-bank': ({ id }) => {
    const b = getBank(id);
    download(`${b.name}.txt`, bankToText(b.questions));
  },
  'del-q': ({ bank, id }) => {
    const b = getBank(bank);
    const q = findQ(bank, id);
    if (!q || !confirm(`刪除這題？\n\n${trunc(q.q, 60)}`)) return;
    b.questions = b.questions.filter((x) => x.id !== id);
    delete state.records[id];
    save();
    render();
  },

  'save-batch': ({ id }) => {
    const b = getBank(id);
    const { questions, errors } = parseText(document.getElementById('batchText').value);
    if (errors.length && !confirm(`有 ${errors.length} 題格式有誤，會被略過：\n\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? '\n…' : ''}\n\n仍要儲存嗎？`)) return;
    const removed = b.questions.length - questions.length;
    if (removed > 0 && !confirm(`儲存後題目會從 ${b.questions.length} 題變成 ${questions.length} 題，確定嗎？`)) return;
    b.questions = assignIds(questions, b.questions, b.id);
    save();
    toast(`已儲存 ${questions.length} 題`);
    history.back();
  },

  'add-opt': () => { collectDraft(); draft.options.push(''); render(); },
  'del-opt': ({ i }) => {
    collectDraft();
    const n = Number(i);
    draft.options.splice(n, 1);
    const fix = (a) => (a > n ? a - 1 : a);
    if (draft.type === 'multi') draft.answer = draft.answer.filter((a) => a !== n).map(fix);
    else draft.answer = draft.answer === n ? -1 : fix(draft.answer);
    render();
  },
  'save-q': ({ next }) => {
    collectDraft();
    const { bank, id } = view.params;
    const b = getBank(bank);
    const r = buildQuestionFromDraft();
    if (r.error) { toast(r.error); return; }
    if (id) {
      const i = b.questions.findIndex((q) => q.id === id);
      b.questions[i] = { ...r.q, id };
    } else {
      r.q.id = `${b.id}-${hash(r.q.q + uid())}`;
      b.questions.push(r.q);
    }
    save();
    if (next) {
      const chapter = draft.chapter;
      draft = null;
      view.params = { bank, chapter };
      history.replaceState(view, '');
      render();
      window.scrollTo(0, 0);
      document.getElementById('dq')?.focus();
      toast(`已新增（共 ${b.questions.length} 題）`);
    } else {
      toast('已儲存');
      history.back();
    }
  },

  'export-all': () => {
    const { current, ...rest } = state;
    const stamp = new Date().toISOString().slice(0, 10);
    download(`刷題本備份-${stamp}.json`, JSON.stringify({ app: 'study-quiz', exported: Date.now(), ...rest }), 'application/json');
  },
  'restore-builtin': () => {
    if (!BUILTIN.length) { toast('沒有內建題庫'); return; }
    if (!confirm('要補回被刪除的內建題庫與內建題目嗎？\n（你自己加的題目不受影響）')) return;
    state.builtinVersions = {};
    syncBuiltins();
    save();
    render();
    toast('已補回內建題庫');
  },
  'check-update': async () => {
    if (!navigator.onLine) { toast('目前沒有網路，連上網路後再試'); return; }
    toast('正在下載最新版…');
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations()) || [];
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
      for (const k of await caches.keys()) if (k.startsWith('study-quiz-')) await caches.delete(k);
    } catch { /* 清不掉也照樣重新載入 */ }
    location.reload();
  },
  'clear-records': () => {
    if (!confirm('清除所有作答紀錄、錯題本與測驗歷史？題目會保留。')) return;
    state.records = {};
    state.history = [];
    state.lastResult = null;
    state.current = null;
    save();
    render();
    toast('已清除作答紀錄');
  },
  'reset-all': () => {
    if (!confirm('全部重置會刪除所有題庫（包含你自己加的題目）與紀錄，無法復原。\n建議先匯出備份。確定嗎？')) return;
    if (!confirm('真的確定要全部重置？')) return;
    state = defaultState();
    syncBuiltins();
    save();
    go('home', {}, { replace: true });
    toast('已重置');
  },
};

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    if (view.name !== nav.dataset.nav) go(nav.dataset.nav);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn({ ...el.dataset }, el);
  }
});

document.addEventListener('keydown', (e) => {
  if (view.name !== 'quiz' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches('button, textarea')) return;
  const cur = state.current;
  const it = cur?.items[cur.idx];
  if (!it) return;
  const inInput = e.target.matches('input');
  if (it.answer !== null) {
    if (e.key === 'Enter' || e.key === 'ArrowRight' || (e.key === ' ' && !inInput)) {
      e.preventDefault();
      nextQuestion();
    }
    return;
  }
  if (inInput) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 8) {
    app.querySelectorAll('.options .opt')[n - 1]?.click();
  } else if (e.key === 'Enter') {
    app.querySelector('[data-action="submit-multi"]')?.click();
  }
});

/* ---------- 啟動 ---------- */

syncBuiltins();
save();
history.replaceState(view, '');
render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
