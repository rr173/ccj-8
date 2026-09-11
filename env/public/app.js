'use strict';
// 前端：登录、文档列表、审阅工作区（划批注 / 划遮罩 / 预览 / 改原文跟随）

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  me: null,
  docs: [],
  doc: null,
  annotations: [],
  events: [],
  selection: null,       // {start,end,text}（content 坐标）
  repositionId: null,   // 正在重新定位的批注
  pollTimer: null,
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || ('请求失败 ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function cpSlice(s, a, b) { return Array.from(s).slice(a, b).join(''); }
function cpLen(s) { return Array.from(s).length; }
function fmtTime(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : ''; }

// ---------- 视图切换 ----------
function show(id) {
  ['loginView', 'externalView', 'listView', 'docView'].forEach(v => $('#' + v).classList.add('hidden'));
  $('#' + id).classList.remove('hidden');
}

// ---------- 登录 ----------
async function boot() {
  try {
    state.me = await api('GET', '/api/me');
    await showList();
  } catch {
    if (location.hash.startsWith('#/ext/')) return showExternal(location.hash.slice(6));
    show('loginView');
    setTimeout(() => $('#loginPw').focus(), 50);
  }
}
$('#loginBtn').onclick = async () => {
  $('#loginErr').textContent = '';
  try {
    const username = $('#loginUser').value;
    await api('POST', '/api/login', { username, password: $('#loginPw').value });
    state.me = { username, role: username === 'author' ? 'author' : 'reviewer' };
    await showList();
  } catch (e) { $('#loginErr').textContent = e.message; }
};
$('#loginPw')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('#loginBtn').click(); });
$('#logoutBtn').onclick = async () => {
  await api('POST', '/api/logout');
  state.me = null;
  location.hash = '';
  show('loginView');
};

// ---------- 文档列表 ----------
async function showList() {
  show('listView');
  $('#whoami').textContent = `${state.me.username}（${state.me.role === 'author' ? '作者' : '审阅人'}）`;
  $('#newDoc').classList.toggle('hidden', state.me.role !== 'author');
  await loadDocs();
}
async function loadDocs() {
  state.docs = await api('GET', '/api/docs');
  const tb = $('#docTable tbody');
  tb.innerHTML = state.docs.map(d => `
    <tr>
      <td>${esc(d.title)}
        ${d.parentId ? '<span class="tag derived">投放稿</span>' : ''}
        ${d.derived ? `<span class="tag master">母稿 ×${d.derived}</span>` : ''}</td>
      <td>${d.status === 'open' ? '<span class="tag open">审阅中</span>' : '<span class="tag closed">已冻结</span>'}</td>
      <td>v${d.version}</td>
      <td>${d.masks}</td>
      <td>${d.parentId ? `${d.released || 0}/${d.paragraphs}` : '—'}</td>
      <td>${fmtTime(d.updatedAt)}</td>
      <td><button data-id="${d.id}" class="link open-doc">打开</button>
          ${state.me.role === 'author' ? `<button data-id="${d.id}" class="link derive-doc">派生</button>` : ''}
          <a href="#/ext/${d.id}" class="open-ext">对外稿</a></td>
    </tr>`).join('');
  tb.querySelectorAll('.open-doc').forEach(b => b.onclick = () => openDoc(b.dataset.id));
  tb.querySelectorAll('.derive-doc').forEach(b => b.onclick = () => deriveDoc(b.dataset.id));
}

// 从母稿派生一份投放稿：与母稿同一份字，已确认遮罩一并带过去
async function deriveDoc(id) {
  const title = prompt('投放稿标题（留空自动命名）：', '');
  if (title === null) return;
  try {
    const doc = await api('POST', `/api/docs/${id}/derive`, { title: title.trim() || undefined });
    toast('已派生：' + doc.title);
    await openDoc(doc.id);
  } catch (e) { toast(e.message); }
}
$('#createBtn').onclick = async () => {
  $('#listErr').textContent = '';
  try {
    const doc = await api('POST', '/api/docs', { title: $('#newTitle').value.trim() || '无标题文案', content: $('#newContent').value });
    $('#newTitle').value = ''; $('#newContent').value = '';
    await openDoc(doc.id);
  } catch (e) { $('#listErr').textContent = e.message; }
};

// ---------- 对外稿 ----------
async function showExternal(id) {
  show('externalView');
  try {
    const d = await api('GET', '/api/docs/' + encodeURIComponent(id) + '/external');
    $('#extTitle').textContent = d.title;
    $('#extStatus').textContent = d.status === 'closed' ? '已冻结对外版' : '审阅中（内容可能继续变化）';
    $('#extStatus').className = 'tag ' + d.status;
    $('#extContent').innerHTML = renderExternalHtml(d.content);
    if (!d.content) {
      $('#extHint').textContent = d.released
        ? ''
        : '（这一份还没有放行任何段落：外面看不到任何内容。）';
      return;
    }
    $('#extHint').textContent = d.masks.length
      ? `共 ${d.masks.length} 段、${d.masks.reduce((a, m) => a + m.len, 0)} 字被遮罩，任何人无法读取。`
      : '';
  } catch (e) {
    $('#extContent').textContent = '加载失败：' + e.message;
  }
}
function renderExternalHtml(text) {
  // text 中 █ 串即遮罩（系统标记已被后端剥离）
  return esc(text).replace(/█+/g, m => `<span class="mask-in-preview">${m}</span>`);
}

// ---------- 审阅工作区 ----------
async function openDoc(id) {
  location.hash = '';
  show('docView');
  await reloadDoc({ keepInput: true });
  $('#whoami2').textContent = `${state.me.username}（${state.me.role === 'author' ? '作者' : '审阅人'}）`;
  $('#closeDocBtn').classList.toggle('hidden', state.me.role !== 'reviewer');
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if ($('#docView').classList.contains('hidden')) return;
    if (!$('#maskModal').classList.contains('hidden')) return;
    if (!$('#annModal').classList.contains('hidden')) return;
    if (document.activeElement === $('#contentInput')) return;
    reloadDoc({ keepInput: true, silent: true });
  }, 5000);
}
$('#backBtn').onclick = () => { clearInterval(state.pollTimer); showList(); };
$('#deriveBtn').onclick = () => deriveDoc(state.doc.id);
$('#extLinkBtn').onclick = () => {
  const url = location.origin + '/#/ext/' + state.doc.id;
  navigator.clipboard?.writeText(url).then(() => toast('对外稿链接已复制：' + url), () => toast(url, 4000));
};
$('#closeDocBtn').onclick = async () => {
  if (!confirm('结束审阅后原文冻结，不能再加批注或遮罩。确定？')) return;
  try {
    await api('POST', `/api/docs/${state.doc.id}/close`, {});
    await reloadDoc();
  } catch (e) { toast(e.message); }
};

async function reloadDoc(opts = {}) {
  try {
    const [doc, annotations, events] = await Promise.all([
      api('GET', '/api/docs/' + encodeURIComponent(opts.id || (state.doc && state.doc.id))),
      api('GET', `/api/docs/${opts.id || (state.doc && state.doc.id)}/annotations`),
      api('GET', `/api/docs/${opts.id || (state.doc && state.doc.id)}/events`),
    ]).catch(async () => {
      // id 仅在第一次有；上面 Promise 拿不到时退化为顺序
      const id = opts.id || state.doc.id;
      return [
        await api('GET', '/api/docs/' + id),
        await api('GET', `/api/docs/${id}/annotations`),
        await api('GET', `/api/docs/${id}/events`),
      ];
    });
    state.doc = doc; state.annotations = annotations; state.events = events;
    renderDoc(opts);
  } catch (e) {
    if (!opts.silent) toast(e.message);
  }
}

function renderDoc(opts = {}) {
  const doc = state.doc;
  const sig = doc.version + '|' + state.annotations.map(a =>
    `${a.id}:${a.status}:${a.start}-${a.end}`).join(',');
  if (opts.silent && state._lastSig === sig) return;
  state._lastSig = sig;
  $('#docTitle').textContent = doc.title;
  $('#docStatus').textContent = doc.status === 'open' ? '审阅中' : '已冻结';
  $('#docStatus').className = 'tag ' + doc.status;
  $('#docVersion').textContent = 'v' + doc.version + ' · 更新于 ' + fmtTime(doc.updatedAt);
  // 派生关系：投放稿显示母稿链接；母稿显示已派生份数
  const lin = $('#docLineage');
  if (doc.parent) {
    lin.innerHTML = `· 投放稿，母稿 <a href="#" class="parent-link">${esc(doc.parent.title)}</a>`;
    lin.querySelector('.parent-link').onclick = e => { e.preventDefault(); openDoc(doc.parent.id); };
  } else if (doc.derived && doc.derived.length) {
    lin.textContent = `· 母稿，已派生 ${doc.derived.length} 份投放稿`;
  } else {
    lin.textContent = '· 母稿';
  }
  $('#deriveBtn').classList.toggle('hidden', state.me.role !== 'author');
  renderContent();
  renderAnnotationList();
  renderMaskCard();
  renderReleaseCard();
  renderEvents();
  const isAuthor = state.me.role === 'author';
  const frozen = doc.status !== 'open';
  $('#authorEdit').classList.toggle('hidden', !isAuthor);
  $('#selectHint').textContent = frozen
    ? '审阅已结束，正文已冻结。'
    : (isAuthor ? '作者只读视图；改原文请用下方编辑框。' : '在正文上拖选文字，即可批注或遮罩。');
  if (isAuthor && (!opts.keepInput || document.activeElement !== $('#contentInput'))) {
    $('#contentInput').value = doc.content;
  }
  $('#closeDocBtn').disabled = frozen;
  $('#previewMaskBtn').disabled = frozen;
}

// 把正文解析成段：{kind:'text'|'mask', start,end, text}
function parseSegments(content) {
  const chars = Array.from(content);
  const segs = [];
  let i = 0, plainStart = 0;
  const flush = end => {
    if (end > plainStart) segs.push({ kind: 'text', start: plainStart, end, text: chars.slice(plainStart, end).join('') });
  };
  while (i < chars.length) {
    if (chars[i] === '⟦') {
      let j = i + 1, n = 0;
      while (chars[j] === '█') { n++; j++; }
      if (chars[j] === '⟧') {
        j++;
        flush(i);
        segs.push({ kind: 'mask', start: i, end: j, len: n });
        i = j; plainStart = j; continue;
      }
    }
    i++;
  }
  flush(chars.length);
  return segs;
}

// 高亮区间（不含已确认遮罩块本身）
function activeHighlights() {
  return state.annotations
    .filter(a => a.start !== null && a.status === 'proposed')
    .map(a => ({ id: a.id, start: a.start, end: a.end, kind: a.kind, status: a.status }));
}

function renderContent() {
  const host = $('#contentRender');
  host.innerHTML = '';
  const content = state.doc.content;
  const chars = Array.from(content);
  const segs = parseSegments(content);
  const highs = activeHighlights();
  const releasedSet = state.doc.parentId ? releasedIndexSet() : new Set();
  const bounds = state.doc.paragraphs || [];

  for (let pi = 0; pi < bounds.length; pi++) {
    const pEl = document.createElement('div');
    pEl.className = 'para' + (releasedSet.has(pi) ? ' released' : '');
    if (releasedSet.has(pi)) pEl.title = '该段已放行对外（只可见放行时遮完后的字）';
    const pStart = bounds[pi].start, pEnd = bounds[pi].end;

    for (const seg of segs.filter(s => s.start < pEnd && s.end > pStart)) {
      const s0 = Math.max(seg.start, pStart), e0 = Math.min(seg.end, pEnd);
      if (seg.kind === 'mask') {
        const el = document.createElement('span');
        el.className = 'mask-confirmed';
        el.textContent = '█'.repeat(seg.len);
        el.title = '已确认遮罩，原文已永久抹除';
        pEl.appendChild(el);
        continue;
      }
      // 每个字归属的批注 id（按优先级取一个类；id 存全部，点击取第一个）
      let runStart = s0;
      let runCls = null, runIds = null;
      const flushRun = (end) => {
        if (end <= runStart) return;
        const el = document.createElement('span');
        if (runCls) { el.className = 'ann ' + runCls; el.dataset.ann = runIds[0]; el.title = '点击查看批注'; }
        el.textContent = chars.slice(runStart, end).join('');
        pEl.appendChild(el);
        runStart = end;
      };
      for (let p = s0; p < e0; p++) {
        const covers = highs.filter(h => h.start <= p && p < h.end && h.kind !== 'mask');
        const mask = highs.find(h => h.start <= p && p < h.end && h.kind === 'mask');
        let cls = null, ids = null;
        if (mask) { cls = 'mask-pending'; ids = [mask.id]; }
        else if (covers.length) {
          const c = covers[0];
          cls = c.kind === 'suggest' ? 'suggest' : 'comment';
          ids = covers.map(x => x.id);
        }
        const key = cls === null ? '' : cls + '|' + ids.join(',');
        const curKey = runCls === null ? '' : runCls + '|' + runIds.join(',');
        if (key !== curKey) { flushRun(p); runCls = cls; runIds = ids ? [...ids] : null; }
      }
      flushRun(e0);
    }
    host.appendChild(pEl);
  }

  host.onclick = e => {
    const annEl = e.target.closest('.ann, .mask-pending');
    if (annEl) {
      $$('#contentRender .ann.active').forEach(x => x.classList.remove('active'));
      annEl.classList.add('active');
      openAnnotation(annEl.dataset.ann);
    }
  };
}

// 选区 -> content 坐标
$('#contentRender').addEventListener('mouseup', () => setTimeout(handleSelection, 0));
$('#contentRender').addEventListener('keyup', e => { if (e.key === 'Shift') setTimeout(handleSelection, 0); });

// 某段 .para 在整篇 content 中的起始 code-point 偏移
function paraOffset(paraEl) {
  const host = $('#contentRender');
  let off = 0;
  let prev = paraEl.previousSibling;
  while (prev) { off += cpLen(prev.textContent); prev = prev.previousSibling; }
  void host;
  return off;
}

function spanStart(span) {
  const para = span.closest('.para');
  let base = para ? paraOffset(para) : 0;
  let prev = span.previousSibling;
  while (prev) {
    base += cpLen(prev.textContent);
    prev = prev.previousSibling;
  }
  return base;
}

function pointToContent(node, offset) {
  const host = $('#contentRender');
  if (node.nodeType === Node.TEXT_NODE) {
    const span = node.parentElement;
    if (!host.contains(span)) return null;
    return spanStart(span) + Array.from(node.data).slice(0, offset).length;
  }
  if (node === host) {
    let p = 0;
    for (let i = 0; i < offset && i < node.childNodes.length; i++) p += cpLen(node.childNodes[i].textContent);
    return p;
  }
  if (node.classList && node.classList.contains('para')) {
    let p = paraOffset(node);
    for (let i = 0; i < offset && i < node.childNodes.length; i++) p += cpLen(node.childNodes[i].textContent);
    return p;
  }
  return null;
}

function handleSelection() {
  if (state.me.role !== 'reviewer' || state.doc.status !== 'open') { hidePop(); return; }
  const sel = window.getSelection();
  const host = $('#contentRender');
  if (!sel.rangeCount || !host.contains(sel.anchorNode)) { hidePop(); return; }
  const range = sel.getRangeAt(0);
  if (range.collapsed) { hidePop(); return; }
  let a = pointToContent(sel.anchorNode, sel.anchorOffset);
  let b = pointToContent(sel.focusNode, sel.focusOffset);
  if (a === null || b === null) { hidePop(); return; }
  if (a > b) [a, b] = [b, a];
  // 与已确认遮罩相交则拒绝
  const segs = parseSegments(state.doc.content);
  if (segs.some(s => s.kind === 'mask' && a < s.end && b > s.start)) {
    hidePop();
    toast('选区包含已确认遮罩，无法批注');
    sel.removeAllRanges();
    return;
  }
  const text = cpSlice(state.doc.content, a, b);
  state.selection = { start: a, end: b, text };
  const pop = $('#selectPop');
  pop.classList.remove('hidden');
  $('#selectText').textContent = `已选 ${b - a} 字：${text.slice(0, 24)}${text.length > 24 ? '…' : ''}`;
  // 重新定位模式：只显示定位按钮
  pop.querySelectorAll('button[data-kind]').forEach(btn => btn.classList.toggle('hidden', !!state.repositionId));
  let rp = pop.querySelector('button[data-reposition]');
  if (state.repositionId) {
    if (!rp) {
      rp = document.createElement('button');
      rp.dataset.reposition = '1';
      rp.textContent = '把失位批注定位到这里';
      rp.onclick = doReposition;
      pop.appendChild(rp);
    }
  } else if (rp) rp.remove();
}
function hidePop() { $('#selectPop').classList.add('hidden'); }
$('#selectPop').querySelectorAll('button[data-kind]').forEach(btn => {
  btn.onclick = () => openCreateModal(btn.dataset.kind);
});
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#selectPop') && !e.target.closest('#contentRender')) hidePop();
});

async function doReposition() {
  const id = state.repositionId;
  const { start, end } = state.selection;
  try {
    await api('POST', `/api/docs/${state.doc.id}/annotations/${id}/reposition`, { start, end, version: state.doc.version });
    state.repositionId = null;
    hidePop(); window.getSelection().removeAllRanges();
    toast('批注已重新定位');
    await reloadDoc();
  } catch (e) { toast(e.message); }
}

// ---------- 新建批注弹层 ----------
function openCreateModal(kind) {
  const { start, end, text } = state.selection;
  const titles = { comment: '加批注（可逆）', suggest: '提修改建议（作者可接受/打回）', mask: '划遮罩（确认后不可逆）' };
  $('#annModalTitle').textContent = titles[kind];
  $('#annModalBody').innerHTML = `
    <div class="quote">${esc(text)}</div>
    ${kind === 'comment' ? '<textarea id="m_note" rows="4" placeholder="批注意见…"></textarea>' : ''}
    ${kind === 'suggest' ? `
      <label>批注说明（可选）<input id="m_note" maxlength="2000"></label>
      <label>建议替换为<textarea id="m_repl" rows="4">${esc(text)}</textarea></label>` : ''}
    ${kind === 'mask' ? '<div class="warn">此操作只是“提议”。随后必须在右侧“不可逆遮罩”里预览并确认，才会真正抹除。</div>' : ''}
  `;
  $('#annModal').classList.remove('hidden');
  $('#annModalOk').onclick = async () => {
    try {
      const payload = {
        kind, start, end, version: state.doc.version,
        note: $('#m_note') ? $('#m_note').value : '',
        replacement: kind === 'suggest' ? $('#m_repl').value : undefined,
      };
      await api('POST', `/api/docs/${state.doc.id}/annotations`, payload);
      $('#annModal').classList.add('hidden');
      hidePop(); window.getSelection().removeAllRanges();
      await reloadDoc();
    } catch (e) { toast(e.message); }
  };
}
$('#annModalCancel').onclick = () => $('#annModal').classList.add('hidden');

// ---------- 批注侧栏 ----------
const STATUS_TEXT = { proposed: '待处理', orphaned: '失去位置', accepted: '作者已接受', rejected: '已打回', sealed: '已随遮罩封存' };
function renderAnnotationList() {
  const host = $('#annList');
  const anns = state.annotations.filter(a => a.kind !== 'mask');
  if (!anns.length) { host.innerHTML = '<p class="hint">暂无批注。</p>'; return; }
  const isAuthor = state.me.role === 'author';
  host.innerHTML = anns.map(a => {
    const quote = a.sealed
      ? '<div class="quote">（此批注引用的文字已被遮罩，内容已封存，任何人不可读）</div>'
      : `<div class="quote">${esc(a.covered || '')}</div>`;
    let body = '';
    if (a.sealed) {
      body = '<p class="muted">批注内容已随遮罩永久封存。</p>';
    } else if (a.status === 'orphaned') {
      body = `<p class="error">原文此处被改动，批注已失去位置。${isAuthor ? '可打回该批注。' : '请在正文上重新选定位置。'}</p>
              <p>${a.note ? esc(a.note) : ''}</p>`;
    } else {
      if (a.kind === 'suggest') {
        body += `<p><b>建议改为：</b></p><div class="quote">${esc(a.replacement || '')}</div>`;
      }
      if (a.note) body += `<p>${esc(a.note)}</p>`;
    }
    let actions = '';
    if (state.doc.status === 'open' && !a.sealed) {
      if (isAuthor) {
        if (a.status === 'proposed') {
          actions = a.kind === 'suggest'
            ? '<button class="primary act" data-act="accept">接受（原文替换、可再打回前）</button><button class="act" data-act="reject">打回</button>'
            : '<button class="primary act" data-act="accept">知道了</button><button class="act" data-act="reject">打回</button>';
        }
      } else if (a.status === 'orphaned') {
        actions = '<button class="act" data-act="reposition">重新定位</button>';
      }
    }
    return `<div class="ann-item ${a.sealed ? 'sealed' : a.kind}" data-id="${a.id}">
      <div class="meta"><span class="badge ${a.status}">${STATUS_TEXT[a.status]}</span>
        <span>${a.kind === 'suggest' ? '修改建议' : '批注'}</span><span>${esc(a.author)} · ${fmtTime(a.createdAt)}</span></div>
      ${quote}${body}<div class="row">${actions}</div></div>`;
  }).join('');
  host.querySelectorAll('.act').forEach(btn => {
    btn.onclick = () => resolveAction(btn.closest('.ann-item').dataset.id, btn.dataset.act);
  });
}

async function resolveAction(id, act) {
  try {
    if (act === 'reposition') {
      state.repositionId = id;
      toast('请在正文上拖选新位置，然后点“把失位批注定位到这里”', 4000);
      return;
    }
    const r = await api('POST', `/api/docs/${state.doc.id}/annotations/${id}/resolve`,
      { action: act, version: state.doc.version });
    if (act === 'accept') toast('已接受，原文已更新');
    if (act === 'reject') toast('已打回，原文保持不变');
    await reloadDoc();
    void r;
  } catch (e) {
    if (e.status === 409) { toast(e.message); await reloadDoc(); }
    else toast(e.message);
  }
}

async function openAnnotation(id) {
  const a = state.annotations.find(x => x.id === id);
  if (!a || a.kind === 'mask') return;
  const el = document.querySelector(`.ann-item[data-id="${id}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- 按段放行（投放稿、作者） ----------
function releasedIndexSet() {
  return new Set((state.doc.releases || []).map(r => r.currentIndex).filter(i => i !== null));
}
function renderReleaseCard() {
  const card = $('#releaseCard');
  // 仅投放稿展示
  if (!state.doc.parentId) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const isAuthor = state.me.role === 'author';
  const host = $('#releaseList');
  const rels = state.doc.releases || [];
  const done = releasedIndexSet();
  const paras = (state.doc.paragraphs || []).map((b, i) => {
    const text = cpSlice(state.doc.content, b.start, b.end);
    const released = done.has(i);
    const preview = text.replace(/⟦█+⟧/g, m => '█'.repeat(Math.max(1, (m.match(/█/g) || []).length)));
    return `<div class="rel-item ${released ? 'done' : ''}">
      <div class="meta"><span class="badge ${released ? 'accepted' : 'proposed'}">${released ? '已放行' : '未放行'}</span>
        <span>第 ${i + 1} 段</span></div>
      <div class="quote rel-quote">${esc(preview.slice(0, 60))}${preview.length > 60 ? '…' : ''}</div>
      ${isAuthor && !released ? `<button class="primary act-release" data-p="${i}">放行此段（不可收回）</button>` : ''}
    </div>`;
  }).join('');
  const orphaned = rels.filter(r => r.currentIndex === null).length;
  host.innerHTML = paras
    + (orphaned ? `<p class="hint">另有 ${orphaned} 段放行后正文改动较大、已失去当前段位置；对外快照仍保留且只会更严。</p>` : '');
  host.querySelectorAll('.act-release').forEach(btn => {
    btn.onclick = () => releaseParagraph(Number(btn.dataset.p));
  });
}

async function releaseParagraph(p) {
  if (!confirm(`确定放行第 ${p + 1} 段？\n\n放行后外面只能看到放行这一刻遮完后的字；放行不可收回、不可重复放行，之后新增的遮罩仍会继续遮住这段对应内容。`)) return;
  try {
    await api('POST', `/api/docs/${state.doc.id}/release`, { paragraph: p, version: state.doc.version });
    toast(`第 ${p + 1} 段已放行`);
    await reloadDoc();
  } catch (e) {
    if (e.status === 409) { toast(e.message); await reloadDoc(); }
    else toast(e.message);
  }
}

// ---------- 遮罩侧栏 ----------
function renderMaskCard() {
  const host = $('#maskList');
  const masks = state.annotations.filter(a => a.kind === 'mask');
  const isReviewer = state.me.role === 'reviewer';
  $('#maskCard').classList.toggle('hidden', !isReviewer);
  if (!masks.length) { host.innerHTML = '<p class="hint">暂无待确认遮罩。</p>'; return; }
  host.innerHTML = masks.map(a => {
    if (a.status === 'orphaned') {
      return `<div class="mask-item" data-id="${a.id}"><b>遮罩提议已失去位置</b>
        <p class="hint">原文被改动，请重新选定位置。</p>
        <button class="act-mask-repos" data-id="${a.id}">重新定位</button></div>`;
    }
    return `<div class="mask-item" data-id="${a.id}">
      <b>待确认遮罩 · ${a.end - a.start} 字</b>
      <div class="hint">${fmtTime(a.createdAt)} 提议；确认后此段文字永久抹除</div></div>`;
  }).join('');
  host.querySelectorAll('.act-mask-repos').forEach(b => b.onclick = () => resolveAction(b.dataset.id, 'reposition'));
}

// ---------- 遮罩预览/确认 ----------
$('#previewMaskBtn').onclick = async () => openMaskPreview();

async function openMaskPreview(ids) {
  try {
    const r = await api('POST', `/api/docs/${state.doc.id}/masks/preview`,
      { ids: ids || null });
    if (!r.masks.length) { toast('没有待确认的遮罩提议'); return; }
    $('#maskPreview').innerHTML = renderExternalHtml(r.preview);
    $('#maskChecks').innerHTML = r.masks.map(m => `
      <label style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" class="mask-check" value="${m.id}" checked style="width:auto">
        遮罩段 ${m.id}（${m.len} 字，位置 ${m.start}–${m.end}）
      </label>`).join('');
    const sealWarn = $('#maskSealWarn');
    if (r.seal.length) {
      sealWarn.classList.remove('hidden');
      sealWarn.textContent = `注意：有 ${r.seal.length} 条批注与遮罩选区重叠，确认后这些批注的内容将一并永久封存（只保留“某条批注被封存”的记录）。`;
    } else sealWarn.classList.add('hidden');
    $('#maskModal').classList.remove('hidden');
    $('#maskChecks').querySelectorAll('.mask-check').forEach(c => c.onchange = async () => {
      const checked = [...$$('#maskChecks .mask-check')].filter(x => x.checked).map(x => x.value);
      if (!checked.length) { $('#maskPreview').textContent = '（未勾选任何遮罩）'; return; }
      const rr = await api('POST', `/api/docs/${state.doc.id}/masks/preview`, { ids: checked });
      $('#maskPreview').innerHTML = renderExternalHtml(rr.preview);
    });
  } catch (e) { toast(e.message); }
}
$('#maskModalCancel').onclick = () => $('#maskModal').classList.add('hidden');
$('#maskModalOk').onclick = async () => {
  const ids = [...$$('#maskChecks .mask-check')].filter(x => x.checked).map(x => x.value);
  if (!ids.length) { toast('请至少勾选一段'); return; }
  if (!confirm(`确认对 ${ids.length} 段执行不可逆遮罩？\n\n确认后被遮的字立即从正文和历史中抹除，作者和审阅人都永远无法再读出，无法撤销。`)) return;
  try {
    const r = await api('POST', `/api/docs/${state.doc.id}/masks/confirm`, { ids, version: state.doc.version });
    $('#maskModal').classList.add('hidden');
    toast(`已永久遮罩 ${ids.length} 段${r.sealed.length ? `，封存批注 ${r.sealed.length} 条` : ''}`);
    await reloadDoc();
  } catch (e) {
    if (e.status === 409) { toast(e.message); await reloadDoc(); }
    else toast(e.message);
  }
};

// ---------- 作者改原文 ----------
$('#saveContentBtn').onclick = async () => {
  $('#editMsg').textContent = '';
  const content = $('#contentInput').value;
  if (content === state.doc.content) { toast('内容没有变化'); return; }
  try {
    await api('PUT', `/api/docs/${state.doc.id}/content`, { content, version: state.doc.version });
    toast('原文已保存，批注位置已自动跟随');
    await reloadDoc();
  } catch (e) {
    if (e.status === 409) { $('#editMsg').textContent = e.message; await reloadDoc(); }
    else $('#editMsg').textContent = e.message;
  }
};
$('#cancelEditBtn').onclick = () => { $('#contentInput').value = state.doc.content; $('#editMsg').textContent = ''; };

// ---------- 历史 ----------
const EVENT_TEXT = {
  'doc.create': d => (d && d.derivedFrom) ? '自母稿派生创建（与母稿同一份字）' : '创建了文档',
  'doc.derived': d => `派生了投放稿《${d.title}》（与母稿同一份字，已确认遮罩一并带过去）`,
  'doc.edit': d => `修改原文（v${d.fromVersion} → v${d.toVersion}），待处理批注自动跟随位置`,
  'doc.sync': d => `母稿同步：原文更新（v${d.fromVersion} → v${d.toVersion}），本稿自己改过的段保留`,
  'annotation.create': d => `新增${kindName(d.kind)}（${d.len} 字）`,
  'annotation.orphaned': '一条批注因原文改动失去位置（未错批到别处）',
  'annotation.repositioned': '审阅人把失位批注重新定位',
  'comment.accepted': '作者接受了一条批注',
  'comment.rejected': '作者打回了一条批注，原文保持不变',
  'suggest.accepted': '作者接受修改建议，原文已替换',
  'suggest.rejected': '作者打回修改建议，原文保持不变',
  'mask.confirmed': d => `确认不可逆遮罩 ${d.len} 字（原文已抹除，历史不保留被遮内容）`,
  'mask.synced': d => `随母稿确认遮罩，本稿同步遮罩 ${d.len} 字${d.count > 1 ? `（${d.count} 处）` : ''}（原文已抹除）`,
  'annotation.sealed': '一条批注因与遮罩重叠被永久封存',
  'paragraph.released': d => `作者放行第 ${(d.paragraph || 0) + 1} 段（外面只能看到放行时遮完后的字；不可收回）`,
  'release.scrubbed': d => `新增遮罩追加生效：已放行段对外快照再遮 ${d.len} 字（外面能读到的字只会更少）`,
  'review.closed': '审阅结束，对外稿冻结',
};
function kindName(k) { return k === 'mask' ? '遮罩提议' : k === 'suggest' ? '修改建议' : '批注'; }
function renderEvents() {
  $('#eventList').innerHTML = state.events.map(e => {
    const t = EVENT_TEXT[e.type];
    const text = typeof t === 'function' ? t(e.detail || {}) : (t || e.type);
    return `<div class="ev">${fmtTime(e.at)} · ${esc(e.actor)} ${esc(text)}</div>`;
  }).join('') || '<p class="hint">暂无记录。</p>';
}

// ---------- 路由 ----------
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#/ext/')) showExternal(location.hash.slice(6));
});

boot();
