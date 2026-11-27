/* ---------- 🤖 AI 拍照出題：上傳課本照片 → 分批平行送給 AI → 產生題目 → 加入題庫 ---------- */
/* API 設定只存在這台裝置的 localStorage（不會進備份檔、也不會上傳到 GitHub）。 */

const AI_KEY = 'study-ai-config';
const AI_DEFAULT = { endpoint: '', apiKey: '', model: 'gpt-6.1-terra', fast: true, perBatch: 3, parallel: 4, perPhoto: 6 };

function aiConfig() {
  try { return { ...AI_DEFAULT, ...JSON.parse(localStorage.getItem(AI_KEY)) }; } catch { return { ...AI_DEFAULT }; }
}
function aiSaveConfig(c) { localStorage.setItem(AI_KEY, JSON.stringify(c)); }
const aiReady = (c) => c.endpoint && c.apiKey && c.model;

/** 把 https://x.com、https://x.com/v1、https://x.com/v1/chat/completions 都轉成完整網址 */
function aiUrl(endpoint) {
  let u = endpoint.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(u)) return u;
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u + '/chat/completions';
}

/* 目前這一輪的工作（只放在記憶體；照片已先壓縮成 JPEG） */
const aiJob = {
  images: [],      // { id, name, url }
  batches: [],     // { idx, imgs:[id], status:'wait'|'run'|'ok'|'err', text, count, errs, msg, t0, t1 }
  running: false,
  stop: false,
  target: '',      // bank id 或 'new'
  newName: '',
  hint: '',
  extra: '',
  result: null,    // 合併後可編輯的文字
  timer: null,
};

/* --- 照片壓縮：長邊 1600px、JPEG 0.82，上傳快、AI 也看得清楚 --- */
async function aiCompress(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  let w, h, src;
  if (bmp) { w = bmp.width; h = bmp.height; src = bmp; }
  else {
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const s = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

function aiPrompt(cfg, n) {
  return `你是台灣高職老師，要根據學生上傳的課本／講義／考卷照片出練習題。只輸出題目本身，不要任何開場白、結語或 \`\`\` 程式碼框。

【輸出格式（一定要遵守，程式會自動解析）】
## 章節名稱
（空一行）
Q: 題目文字
(A) 選項
(B) 選項 *
(C) 選項
(D) 選項
解析: 詳細解析，可以多行

Q: 填空題題目，空格用 ____
答: 正確答案 | 也接受的寫法
解析: …

【規則】
1. 每題之間空一行；同一題內「不能」有空行。
2. 單選題 4 個選項，正確選項行尾加「 *」；多選題就標兩個以上「 *」。
3. 選項顯示時會被打亂，所以解析裡「不要」寫 (A)(B) 這種字母，要直接寫選項內容。
4. 解析一定要寫，用繁體中文，說明為什麼對、其他選項錯在哪；計算題要列出步驟。
5. 解析的每一行不要用「Q:」「答」「解」「說明」「題」「##」「(A)」開頭。
6. 可以用 Markdown：**粗體**、==重點==、- 清單、1. 步驟。
7. 題目內容要忠實依照照片裡的內容（單字、片語、文法、課文、公式），答案必須正確、只有一個最佳答案（多選題除外）。
8. 英文科：題目與選項用英文，解析用繁體中文；可以出單字、片語、文法、課文理解題。其他科題目用繁體中文。
9. 依照片內容用「## 章節名稱」分章（例如「## U3 單字」「## 3-2 BJT 特性曲線」）。
10. 這一批照片總共出大約 ${n} 題，以單選題為主，可以有少量填空題。照片模糊或與課業無關就略過。`;
}

async function aiCall(cfg, batch) {
  const imgs = batch.imgs.map((id) => aiJob.images.find((x) => x.id === id)).filter(Boolean);
  const n = Math.max(3, imgs.length * cfg.perPhoto);
  const userText = [
    aiJob.hint && `科目／範圍：${aiJob.hint}`,
    aiJob.extra && `補充要求：${aiJob.extra}`,
    `以下是 ${imgs.length} 張照片，請出大約 ${n} 題。`,
  ].filter(Boolean).join('\n');
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: aiPrompt(cfg, n) },
      { role: 'user', content: [{ type: 'text', text: userText }, ...imgs.map((im) => ({ type: 'image_url', image_url: { url: im.url } }))] },
    ],
  };
  if (cfg.fast) { body.service_tier = 'priority'; body.reasoning_effort = 'low'; }
  const ctl = new AbortController();
  batch.ctl = ctl;
  const to = setTimeout(() => ctl.abort(), 300000);
  try {
    const res = await fetch(aiUrl(cfg.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      let m = raw;
      try { m = JSON.parse(raw).error?.message || raw; } catch { /* 原文 */ }
      const err = new Error(`HTTP ${res.status}：${String(m).slice(0, 160)}`);
      err.retry = res.status === 429 || res.status >= 500;
      throw err;
    }
    const j = JSON.parse(raw);
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new Error('AI 沒有回傳內容');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error(aiJob.stop ? '已停止' : '逾時（超過 5 分鐘）'); err.retry = !aiJob.stop; throw err; }
    if (e instanceof TypeError) { const err = new Error('連不到伺服器（網路或網址有誤）'); err.retry = true; throw err; }
    throw e;
  } finally {
    clearTimeout(to);
  }
}

/** 清掉 AI 常見的多餘東西：程式碼框、Q 前面的編號等 */
function aiClean(text) {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^\s*(?:\d+[.、)]\s*)?(?:\*\*)?(Q|題目)\s*(?:\d+)?\s*(?:\*\*)?\s*[:：]/gim, 'Q:')
    .replace(/^\s*(?:\*\*)?(解析|答案?)(?:\*\*)?\s*[:：]/gm, '$1:')
    .trim();
}

async function aiRunBatch(cfg, b) {
  b.status = 'run'; b.t0 = Date.now(); b.msg = '';
  aiRefresh();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = aiClean(await aiCall(cfg, b));
      const { questions, errors } = parseText(text);
      b.text = text; b.count = questions.length; b.errs = errors.length;
      b.status = questions.length ? 'ok' : 'err';
      if (!questions.length) b.msg = 'AI 回傳的內容解析不到題目';
      break;
    } catch (e) {
      b.status = 'err'; b.msg = e.message;
      if (!e.retry || aiJob.stop || attempt) break;
      b.msg += '，重試中…'; aiRefresh();
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  b.t1 = Date.now();
  aiRefresh();
}

async function aiRun(onlyFailed = false) {
  const cfg = aiConfig();
  if (!aiReady(cfg)) { toast('請先填好 API 設定'); return; }
  if (!onlyFailed) {
    const ids = aiJob.images.map((x) => x.id);
    aiJob.batches = [];
    for (let i = 0; i < ids.length; i += cfg.perBatch) {
      aiJob.batches.push({ idx: aiJob.batches.length + 1, imgs: ids.slice(i, i + cfg.perBatch), status: 'wait' });
    }
    aiJob.result = null;
  } else {
    aiJob.batches.filter((b) => b.status === 'err').forEach((b) => { b.status = 'wait'; b.msg = ''; });
  }
  aiJob.running = true; aiJob.stop = false;
  clearInterval(aiJob.timer);
  aiJob.timer = setInterval(() => aiJob.batches.some((b) => b.status === 'run') && aiRefresh(true), 1000);
  aiRefresh();
  const queue = aiJob.batches.filter((b) => b.status === 'wait');
  const worker = async () => {
    while (queue.length && !aiJob.stop) await aiRunBatch(cfg, queue.shift());
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cfg.parallel, queue.length)) }, worker));
  clearInterval(aiJob.timer);
  aiJob.running = false;
  aiJob.result = aiMerge();
  aiRefresh();
  const total = aiJob.batches.reduce((s, b) => s + (b.status === 'ok' ? b.count : 0), 0);
  toast(aiJob.stop ? '已停止' : `完成！共產生 ${total} 題`);
}

/** 合併各批結果，去掉重複題目 */
function aiMerge() {
  const seen = new Set();
  const all = [];
  for (const b of aiJob.batches) {
    if (b.status !== 'ok') continue;
    for (const q of parseText(b.text).questions) {
      const k = normAns(q.q);
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(q);
    }
  }
  return all.length ? bankToText(all) : '';
}

/* 只更新進度區塊，不整頁重畫（避免打字中的欄位被清掉） */
function aiRefresh(onlyTimer) {
  if (view.name !== 'ai') return;
  const box = document.getElementById('aiProgress');
  if (!box) return;
  if (onlyTimer) {
    box.querySelectorAll('[data-t0]').forEach((el) => { el.textContent = Math.round((Date.now() - Number(el.dataset.t0)) / 1000) + 's'; });
    return;
  }
  box.innerHTML = aiProgressHTML();
  const r = document.getElementById('aiResultWrap');
  if (r) { r.innerHTML = aiResultHTML(); aiShowParse(); }
  const go = document.getElementById('aiGoBtns');
  if (go) go.innerHTML = aiGoBtnsHTML();
}

const thumbOf = (id) => aiJob.images.find((x) => x.id === id);

function aiProgressHTML() {
  if (!aiJob.batches.length) return '';
  const done = aiJob.batches.filter((b) => b.status === 'ok' || b.status === 'err').length;
  const total = aiJob.batches.reduce((s, b) => s + (b.status === 'ok' ? b.count : 0), 0);
  const ICON = { wait: '⏸', run: '⏳', ok: '✅', err: '❌' };
  return `
    <div class="ai-sum"><b>${done}/${aiJob.batches.length}</b> 批完成・已產生 <b>${total}</b> 題</div>
    <div class="meter"><i style="width:${pct(done, aiJob.batches.length)}%"></i></div>
    <div class="ai-batches">
      ${aiJob.batches.map((b) => {
        const first = aiJob.images.indexOf(thumbOf(b.imgs[0])) + 1;
        const range = b.imgs.length > 1 ? `${first}–${first + b.imgs.length - 1}` : `${first}`;
        let info = '';
        if (b.status === 'run') info = `產生中… <span data-t0="${b.t0}">${Math.round((Date.now() - b.t0) / 1000)}s</span>`;
        else if (b.status === 'ok') info = `${b.count} 題${b.errs ? `（${b.errs} 題格式不符已略過）` : ''}・${Math.round((b.t1 - b.t0) / 1000)}s`;
        else if (b.status === 'err') info = `<span class="bad">${esc(b.msg)}</span>`;
        else info = '排隊中';
        return `<div class="ai-batch ${b.status}"><span>${ICON[b.status]}</span><span class="grow">第 ${b.idx} 批（照片 ${range}）<br><span class="small muted">${info}</span></span></div>`;
      }).join('')}
    </div>`;
}

function aiGoBtnsHTML() {
  const cfg = aiConfig();
  const n = aiJob.images.length;
  const failed = aiJob.batches.filter((b) => b.status === 'err').length;
  if (aiJob.running) return '<button class="btn block danger" data-action="ai-stop">⏹ 停止</button>';
  return `
    <button class="btn primary block" data-action="ai-run" ${n && aiReady(cfg) ? '' : 'disabled'}>
      ✨ 開始產生（${n} 張照片・分 ${Math.ceil(n / cfg.perBatch) || 0} 批・同時 ${cfg.parallel} 批）</button>
    ${failed ? `<button class="btn block" data-action="ai-retry">🔁 重試失敗的 ${failed} 批</button>` : ''}`;
}

function aiResultHTML() {
  if (aiJob.result == null) return '';
  if (!aiJob.result) return '<div class="card"><p class="muted">沒有產生任何題目，請重試或換照片。</p></div>';
  const banks = state.banks;
  const tgt = aiJob.target || '';
  return `
    <div class="card stack">
      <h2>③ 檢查並加入題庫</h2>
      <p class="small muted">可以直接修改下面的文字（格式同「批次貼上」）。</p>
      <textarea id="aiText" spellcheck="false">${esc(aiJob.result)}</textarea>
      <div id="aiParse" class="small"></div>
      <div class="field">
        <label for="aiTarget">加入到</label>
        <select id="aiTarget">
          <option value="new" ${tgt === 'new' || !tgt ? 'selected' : ''}>＋ 建立新題庫</option>
          ${banks.map((b) => `<option value="${b.id}" ${tgt === b.id ? 'selected' : ''}>${esc(b.icon || '📘')} ${esc(b.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field" id="aiNewWrap" ${tgt && tgt !== 'new' ? 'hidden' : ''}>
        <label for="aiNewName">新題庫名稱</label>
        <input type="text" id="aiNewName" value="${esc(aiJob.newName || aiJob.hint || 'AI 出題')}">
        <label class="check"><input type="checkbox" id="aiToMid" checked> 放在「第二次段考」區</label>
      </div>
      <button class="btn primary block" data-action="ai-save">📥 加入題庫</button>
    </div>`;
}

VIEWS.ai = ({ bank }) => {
  if (bank && !aiJob.target) aiJob.target = bank;
  const cfg = aiConfig();
  const ready = aiReady(cfg);
  return `
    <div class="section-head"><h1>🤖 AI 拍照出題</h1></div>
    <details class="card help" ${ready ? '' : 'open'}>
      <summary>⚙️ API 設定 ${ready ? `<span class="small muted">（${esc(cfg.model)}${cfg.fast ? '・⚡快速' : ''}）</span>` : '<span class="bad small">（尚未設定）</span>'}</summary>
      <div class="stack" style="margin-top:10px">
        <div class="field">
          <label for="aiPaste">快速貼上設定</label>
          <textarea id="aiPaste" class="short" placeholder="把含有 Endpoint URL、Api Key、Model 的文字整段貼在這裡"></textarea>
          <button class="btn small" data-action="ai-paste-cfg">📋 從貼上的文字讀取</button>
        </div>
        <div class="field"><label for="aiEndpoint">Endpoint URL</label><input type="text" id="aiEndpoint" value="${esc(cfg.endpoint)}" placeholder="https://…" autocomplete="off"></div>
        <div class="field"><label for="aiApiKey">API Key</label><input type="password" id="aiApiKey" value="${esc(cfg.apiKey)}" placeholder="sk-…" autocomplete="off"></div>
        <div class="field"><label for="aiModel">Model</label><input type="text" id="aiModel" value="${esc(cfg.model)}"></div>
        <label class="check"><input type="checkbox" id="aiFast" ${cfg.fast ? 'checked' : ''}> ⚡ 快速模式（priority 通道＋低推理）</label>
        <div class="ai-nums">
          <div class="field"><label for="aiPerBatch">每批照片數</label><input type="number" id="aiPerBatch" min="1" max="10" value="${cfg.perBatch}"></div>
          <div class="field"><label for="aiParallel">同時幾批</label><input type="number" id="aiParallel" min="1" max="10" value="${cfg.parallel}"></div>
          <div class="field"><label for="aiPerPhoto">每張約幾題</label><input type="number" id="aiPerPhoto" min="1" max="20" value="${cfg.perPhoto}"></div>
        </div>
        <div class="row">
          <button class="btn primary" data-action="ai-save-cfg">💾 儲存設定</button>
          <button class="btn" data-action="ai-test">🔌 測試連線</button>
        </div>
        <p class="small muted">設定只存在這台裝置，不會上傳、也不會出現在備份檔裡。</p>
      </div>
    </details>

    <div class="card stack">
      <h2>① 選照片</h2>
      <label class="btn block ai-pick">📷 選擇／拍攝照片（可一次選 20 張以上）
        <input type="file" id="aiFiles" accept="image/*" multiple hidden>
      </label>
      <div class="ai-thumbs" id="aiThumbs">${aiThumbsHTML()}</div>
      ${aiJob.images.length ? `<button class="btn small ghost danger" data-action="ai-clear">🗑 清除全部照片</button>` : ''}
    </div>

    <div class="card stack">
      <h2>② 產生題目</h2>
      <div class="field"><label for="aiHint">科目／範圍（建議填）</label><input type="text" id="aiHint" value="${esc(aiJob.hint)}" placeholder="例如：英文 Unit 4、電子學 Ch5"></div>
      <div class="field"><label for="aiExtra">補充要求（選填）</label><input type="text" id="aiExtra" value="${esc(aiJob.extra)}" placeholder="例如：多出文法題、要有計算題"></div>
      <div id="aiGoBtns" class="stack">${aiGoBtnsHTML()}</div>
      <div id="aiProgress" class="stack">${aiProgressHTML()}</div>
    </div>

    <div id="aiResultWrap">${aiResultHTML()}</div>`;
};

function aiThumbsHTML() {
  if (!aiJob.images.length) return '<p class="small muted">還沒有照片。</p>';
  return aiJob.images.map((im, i) => `
    <div class="ai-thumb"><img src="${im.url}" alt=""><span>${i + 1}</span>
      ${aiJob.running ? '' : `<button data-action="ai-del-img" data-id="${im.id}" aria-label="移除">✕</button>`}</div>`).join('');
}

function aiShowParse() {
  const ta = document.getElementById('aiText');
  const box = document.getElementById('aiParse');
  if (!ta || !box) return;
  const { questions, errors } = parseText(ta.value);
  box.innerHTML = `✅ 可加入 <b>${questions.length}</b> 題${errors.length ? `・<span class="bad">⚠ ${errors.length} 題格式有誤會略過</span>` : ''}`;
}

AFTER.ai = () => {
  const $ = (id) => document.getElementById(id);
  $('aiFiles')?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    toast(`處理 ${files.length} 張照片中…`);
    const out = await Promise.all(files.map(async (f) => {
      try { return { id: uid(), name: f.name, url: await aiCompress(f) }; } catch { return null; }
    }));
    aiJob.images.push(...out.filter(Boolean));
    if (out.some((x) => !x)) toast('有照片無法讀取，已略過');
    render();
  });
  $('aiHint')?.addEventListener('input', (e) => { aiJob.hint = e.target.value; });
  $('aiExtra')?.addEventListener('input', (e) => { aiJob.extra = e.target.value; });
  aiShowParse();
};

/* 結果區是 aiRefresh 動態放進去的，事件用委派 */
document.addEventListener('input', (e) => {
  if (view.name !== 'ai') return;
  if (e.target.id === 'aiText') { aiJob.result = e.target.value; aiShowParse(); }
  if (e.target.id === 'aiNewName') aiJob.newName = e.target.value;
});
document.addEventListener('change', (e) => {
  if (view.name !== 'ai' || e.target.id !== 'aiTarget') return;
  aiJob.target = e.target.value;
  document.getElementById('aiNewWrap').hidden = e.target.value !== 'new';
});

function aiReadForm() {
  const v = (id) => document.getElementById(id)?.value.trim() ?? '';
  const num = (id, d, max) => Math.min(max, Math.max(1, parseInt(v(id), 10) || d));
  return {
    endpoint: v('aiEndpoint'), apiKey: v('aiApiKey'), model: v('aiModel') || AI_DEFAULT.model,
    fast: !!document.getElementById('aiFast')?.checked,
    perBatch: num('aiPerBatch', 3, 10), parallel: num('aiParallel', 4, 10), perPhoto: num('aiPerPhoto', 6, 20),
  };
}

Object.assign(ACTIONS, {
  'ai-open': ({ bank }) => go('ai', bank ? { bank } : {}),
  'ai-paste-cfg': () => {
    const t = document.getElementById('aiPaste').value;
    const pick = (re) => (t.match(re) || [])[1]?.trim();
    const endpoint = pick(/(?:endpoint|base\s*url|url)\s*[:：=]\s*(\S+)/i);
    const apiKey = pick(/(?:api\s*key|key|token)\s*[:：=]\s*(\S+)/i);
    const model = pick(/model\s*[:：=]\s*(\S+)/i);
    if (!endpoint && !apiKey && !model) { toast('找不到設定，請確認有 Endpoint URL／Api Key／Model'); return; }
    if (endpoint) document.getElementById('aiEndpoint').value = endpoint;
    if (apiKey) document.getElementById('aiApiKey').value = apiKey;
    if (model) document.getElementById('aiModel').value = model;
    if (/fast/i.test(t)) document.getElementById('aiFast').checked = true;
    document.getElementById('aiPaste').value = '';
    toast('已讀取，記得按「儲存設定」');
  },
  'ai-save-cfg': () => {
    const c = aiReadForm();
    if (c.endpoint && !/^https?:\/\//i.test(c.endpoint)) { toast('Endpoint 要以 https:// 開頭'); return; }
    aiSaveConfig(c);
    toast('設定已儲存');
    render();
  },
  'ai-test': async (_, el) => {
    const c = aiReadForm();
    if (!aiReady(c)) { toast('請先填好三個欄位'); return; }
    el.disabled = true; el.textContent = '⏳ 測試中…';
    const t0 = Date.now();
    try {
      const body = { model: c.model, messages: [{ role: 'user', content: '只回答：OK' }] };
      if (c.fast) { body.service_tier = 'priority'; body.reasoning_effort = 'low'; }
      const res = await fetch(aiUrl(c.endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status} ${j.error?.message || ''}`);
      aiSaveConfig(c);
      toast(`✅ 連線成功（${((Date.now() - t0) / 1000).toFixed(1)}s），設定已儲存`);
    } catch (e) {
      toast(`❌ ${e instanceof TypeError ? '連不到伺服器' : e.message}`.slice(0, 120));
    }
    el.disabled = false; el.textContent = '🔌 測試連線';
  },
  'ai-del-img': ({ id }) => { aiJob.images = aiJob.images.filter((x) => x.id !== id); render(); },
  'ai-clear': () => {
    if (!confirm('清除全部照片和這次的產生結果？')) return;
    aiJob.images = []; aiJob.batches = []; aiJob.result = null;
    render();
  },
  'ai-run': () => {
    if (aiJob.result && !confirm('重新產生會取代目前的結果（還沒加入題庫的會不見），確定？')) return;
    aiRun(false);
  },
  'ai-retry': () => aiRun(true),
  'ai-stop': () => {
    aiJob.stop = true;
    aiJob.batches.forEach((b) => b.status === 'run' && b.ctl?.abort());
  },
  'ai-save': () => {
    const text = document.getElementById('aiText')?.value || '';
    const { questions, errors } = parseText(text);
    if (!questions.length) { toast('沒有可加入的題目'); return; }
    if (errors.length && !confirm(`有 ${errors.length} 題格式有誤會被略過，繼續？`)) return;
    const tgt = document.getElementById('aiTarget').value;
    let b;
    if (tgt === 'new') {
      const name = document.getElementById('aiNewName').value.trim() || 'AI 出題';
      b = { id: 'u' + uid(), name, icon: '🤖', questions: [] };
      if (document.getElementById('aiToMid')?.checked) b.group = '第二次段考';
      state.banks.push(b);
    } else b = getBank(tgt);
    const have = new Set(b.questions.map((q) => normAns(q.q)));
    const fresh = questions.filter((q) => !have.has(normAns(q.q)));
    assignIds(fresh, [], b.id);
    const used = new Set(b.questions.map((q) => q.id));
    fresh.forEach((q) => { while (used.has(q.id)) q.id = `${b.id}-${hash(q.q + uid())}`; used.add(q.id); });
    b.questions.push(...fresh);
    save();
    aiJob.result = null; aiJob.batches = []; aiJob.images = [];
    toast(`已加入 ${fresh.length} 題到「${b.name}」${questions.length > fresh.length ? `（${questions.length - fresh.length} 題重複略過）` : ''}`);
    go('bank', { id: b.id }, { replace: true });
  },
});

/* 如果重新整理時正停在 AI 頁，重畫一次 */
if (view.name === 'ai') render();
