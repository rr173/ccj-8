'use strict';
// 业务逻辑：批注（可逆层）与遮罩（不可逆层）
//
// 不可逆遮罩的安全边界：
//  - 确认遮罩 = 直接把正文中的字替换成 ⟦██…⟧ 占位符，全文重写落盘；
//  - 不保存遮罩前快照、不保存被遮文字、不保存可还原的编码；
//  - 事件历史只记“遮罩 N 字”，批注若引用了被遮范围，其备注/替换文一律清空封存；
//  - 外部稿接口剥离标记，只给出可公开文本。

const {
  codePoints, contentOpcodes, mapRange, maskBlock, extractMasks,
  validateAuthorEdit, cpLen, MARK, MARK_END, hashPassword, randomToken,
} = require('./util');

class Service {
  constructor(store) {
    this.store = store;
  }

  // ---------- 初始化 ----------
  async initUsers(authorPw, reviewerPw) {
    await this.store.tx(d => {
      if (!d.secret) d.secret = randomToken();
      if (!d.users.author) d.users.author = { passHash: hashPassword(authorPw), role: 'author' };
      if (!d.users.reviewer) d.users.reviewer = { passHash: hashPassword(reviewerPw), role: 'reviewer' };
    });
    return this.store.read(d => d.secret);
  }

  getUser(username) {
    return this.store.read(d => d.users[username] || null);
  }

  _event(d, type, actor, docId, detail = {}) {
    const id = 'ev_' + (++d.counters.event);
    const ev = { id, type, actor, docId, at: new Date().toISOString(), detail };
    d._events = d._events || [];
    d._events.push(ev);
    if (d._events.length > 5000) d._events = d._events.slice(-5000);
    return ev;
  }
  async events(docId, limit = 200) {
    return this.store.read(d => (d._events || []).filter(e => !docId || e.docId === docId).slice(-limit).reverse());
  }

  // ---------- 文档 ----------
  async listDocs() {
    return this.store.read(d => Object.values(d.docs).map(doc => ({
      id: doc.id, title: doc.title, status: doc.status, version: doc.version,
      updatedAt: doc.updatedAt, masks: extractMasks(doc.content).length,
    })));
  }

  async getDoc(id) {
    return this.store.read(d => d.docs[id] || null);
  }

  async createDoc(title, content, actor) {
    return this.store.tx(d => {
      const id = 'doc_' + (++d.counters.doc);
      const now = new Date().toISOString();
      const doc = {
        id, title, content, version: 1, status: 'open',
        createdAt: now, updatedAt: now, closedAt: null,
      };
      d.docs[id] = doc;
      d._ann = d._ann || {};
      this._event(d, 'doc.create', actor, id, { title });
      return doc;
    });
  }

  // 关闭审阅：冻结对外稿
  async closeDoc(id, actor) {
    return this.store.tx(d => {
      const doc = d.docs[id];
      if (!doc) throw httpError(404, '文档不存在');
      doc.status = 'closed';
      doc.closedAt = new Date().toISOString();
      this._event(d, 'review.closed', actor, id, {});
      return doc;
    });
  }

  // 对外稿：剥离系统标记，只返回可公开文本；另附遮罩段位置
  async external(id) {
    const doc = await this.getDoc(id);
    if (!doc) throw httpError(404, '文档不存在');
    const chars = codePoints(doc.content);
    let out = '';
    const ranges = [];
    let oi = 0, i = 0;
    while (i < chars.length) {
      if (chars[i] === MARK) {
        let j = i + 1, n = 0;
        while (chars[j] === '█') { n++; j++; }
        if (chars[j] === MARK_END) {
          ranges.push({ start: oi, end: oi + n, len: n });
          out += '█'.repeat(n);
          oi += n; i = j + 1; continue;
        }
      }
      out += chars[i]; oi++; i++;
    }
    return { id: doc.id, title: doc.title, status: doc.status, content: out, masks: ranges, closedAt: doc.closedAt };
  }

  // ---------- 批注查询 ----------
  async annotations(docId) {
    return this.store.read(d => Object.values(d._ann || {})
      .filter(a => a.docId === docId)
      .sort((x, y) => x.start === null ? 1 : (y.start === null ? -1 : x.start - y.start))
      .map(a => this._publicAnnotation(d, docId, a)));
  }

  _publicAnnotation(d, docId, a) {
    const doc = d.docs[docId];
    const base = {
      id: a.id, kind: a.kind, status: a.status,
      start: a.start, end: a.end, version: a.version,
      author: a.author, createdAt: a.createdAt,
      resolvedBy: a.resolvedBy || null, resolvedAt: a.resolvedAt || null,
      maskLen: a.maskLen || null,
    };
    if (a.status === 'sealed') {
      // 封存：只能看到这里曾有一条批注，正文/替换文/备注全部不可见
      return { ...base, note: null, replacement: null, sealed: true, sealedReason: a.sealedReason || 'mask-overlap' };
    }
    return {
      ...base,
      note: a.note || '',
      replacement: a.kind === 'suggest' ? a.replacement : null,
      // 批注当前覆盖的文字（由正文实时截取，不单独存储副本）
      covered: (a.start !== null && doc) ? codePoints(doc.content).slice(a.start, a.end).join('') : null,
    };
  }

  _assertOpen(doc) {
    if (doc.status !== 'open') throw httpError(409, '审阅已结束，文档已冻结');
  }
  _assertVersion(doc, expected) {
    if (expected !== undefined && expected !== null && Number(expected) !== doc.version) {
      throw httpError(409, '文档已被他人修改，请刷新后重试（当前版本 ' + doc.version + '）');
    }
  }
  _checkRange(doc, start, end) {
    const len = cpLen(doc.content);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > len) {
      throw httpError(400, '选区超出正文范围');
    }
  }

  // ---------- 创建批注（评论 / 修改建议 / 遮罩提议） ----------
  async addAnnotation({ docId, kind, start, end, note, replacement }, actor, expectedVersion) {
    if (!['comment', 'suggest', 'mask'].includes(kind)) throw httpError(400, '批注类型错误');
    if (kind === 'mask' && actor !== 'reviewer') throw httpError(403, '只有审阅人可以发起遮罩');
    if (kind !== 'mask' && actor !== 'reviewer') throw httpError(403, '只有审阅人可以添加批注');
    if (note && note.length > 2000) throw httpError(400, '备注过长');
    return this.store.tx(d => {
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      this._assertOpen(doc);
      this._assertVersion(doc, expectedVersion);
      this._checkRange(doc, start, end);
      for (const m of extractMasks(doc.content)) {
        if (start < m.end && end > m.start) throw httpError(400, '选区与已确认遮罩重叠');
      }
      const anns = Object.values(d._ann || {}).filter(a => a.docId === docId);
      if (kind === 'mask') {
        for (const a of anns) {
          if (a.kind === 'mask' && a.status === 'proposed' && a.start !== null &&
              start < a.end && end > a.start) {
            throw httpError(400, '与待确认的遮罩提议重叠');
          }
        }
        if (end - start < 1) throw httpError(400, '遮罩至少覆盖 1 个字');
      } else if (kind === 'suggest') {
        if (typeof replacement !== 'string') throw httpError(400, '修改建议需要替换文本');
        if (replacement.length > 10000) throw httpError(400, '替换文本过长');
      }
      d._ann = d._ann || {};
      const id = 'ann_' + (++d.counters.ann);
      const ann = {
        id, docId, kind, status: 'proposed',
        start, end, version: doc.version,
        note: note || '',
        replacement: kind === 'suggest' ? replacement : null,
        maskLen: kind === 'mask' ? end - start : null,
        author: actor, createdAt: new Date().toISOString(),
      };
      d._ann[id] = ann;
      // 历史不记录备注与覆盖文字，只记录类型与长度
      this._event(d, 'annotation.create', actor, docId, { annotation: id, kind, len: end - start });
      return this._publicAnnotation(d, docId, ann);
    });
  }

  // 审阅人改选区位（批注被作者改文冲掉后，重新指到正确位置）
  async repositionAnnotation(docId, annId, start, end, actor, expectedVersion) {
    if (actor !== 'reviewer') throw httpError(403, '只有审阅人可以重新定位批注');
    return this.store.tx(d => {
      const doc = d.docs[docId];
      const a = d._ann && d._ann[annId];
      if (!doc || !a || a.docId !== docId) throw httpError(404, '批注不存在');
      this._assertOpen(doc);
      this._assertVersion(doc, expectedVersion);
      if (!['proposed', 'orphaned'].includes(a.status)) throw httpError(409, '该批注已结束，不能移动');
      this._checkRange(doc, start, end);
      for (const m of extractMasks(doc.content)) {
        if (start < m.end && end > m.start) throw httpError(400, '选区与已确认遮罩重叠');
      }
      a.start = start; a.end = end; a.status = 'proposed'; a.version = doc.version;
      this._event(d, 'annotation.repositioned', actor, docId, { annotation: annId, len: end - start });
      return this._publicAnnotation(d, docId, a);
    });
  }

  // 作者接受 / 打回
  async resolveAnnotation(docId, annId, action, actor, expectedVersion) {
    if (actor !== 'author') throw httpError(403, '只有作者可以接受或打回');
    if (!['accept', 'reject'].includes(action)) throw httpError(400, '操作错误');
    return this.store.tx(d => {
      const doc = d.docs[docId];
      const a = d._ann && d._ann[annId];
      if (!doc || !a || a.docId !== docId) throw httpError(404, '批注不存在');
      this._assertOpen(doc);
      this._assertVersion(doc, expectedVersion);
      if (a.status !== 'proposed') throw httpError(409, '该批注不是待处理状态');
      if (a.kind === 'mask') throw httpError(400, '遮罩请用预览/确认流程，不能接受或打回');

      if (action === 'reject') {
        a.status = 'rejected';
        a.resolvedBy = actor; a.resolvedAt = new Date().toISOString();
        this._event(d, a.kind === 'suggest' ? 'suggest.rejected' : 'comment.rejected', actor, docId, { annotation: annId });
        return { doc: this._docView(d, doc), annotation: this._publicAnnotation(d, docId, a) };
      }

      if (a.kind === 'comment') {
        a.status = 'accepted';
        a.resolvedBy = actor; a.resolvedAt = new Date().toISOString();
        this._event(d, 'comment.accepted', actor, docId, { annotation: annId });
        return { doc: this._docView(d, doc), annotation: this._publicAnnotation(d, docId, a) };
      }

      // suggest：把替换文写进正文，其他活动批注按 diff 跟随
      const chars = codePoints(doc.content);
      const next = chars.slice(0, a.start).join('') + a.replacement + chars.slice(a.end).join('');
      this._remapActive(d, doc, next, { skipAnnId: a.id });
      doc.content = next;
      doc.version += 1;
      doc.updatedAt = new Date().toISOString();
      a.status = 'accepted';
      a.resolvedBy = actor; a.resolvedAt = new Date().toISOString();
      // 建议本身成为历史；其坐标按替换段对齐（仅用于显示）
      a.start = a.start; a.end = a.start + cpLen(a.replacement);
      this._event(d, 'suggest.accepted', actor, docId, { annotation: annId, replacedLen: 0 });
      return { doc: this._docView(d, doc), annotation: this._publicAnnotation(d, docId, a) };
    });
  }

  // ---------- 作者改原文：活动批注自动跟随 ----------
  async editContent(docId, content, actor, expectedVersion) {
    if (actor !== 'author') throw httpError(403, '只有作者可以修改原文');
    return this.store.tx(d => {
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      this._assertOpen(doc);
      this._assertVersion(doc, expectedVersion);
      const err = validateAuthorEdit(doc.content, content);
      if (err) throw httpError(400, err);
      this._remapActive(d, doc, content);
      doc.content = content;
      doc.version += 1;
      doc.updatedAt = new Date().toISOString();
      this._event(d, 'doc.edit', actor, docId, { fromVersion: doc.version - 1, toVersion: doc.version });
      return this._docView(d, doc);
    });
  }

  // 用 old->new 的 diff 重映射所有“待处理”批注；冲掉的标 orphaned。
  _remapActive(d, doc, next, opts = {}) {
    const ops = contentOpcodes(doc.content, next);
    const anns = Object.values(d._ann || {}).filter(a => a.docId === doc.id);
    for (const a of anns) {
      if (opts.skipAnnId === a.id) continue;
      if (a.status !== 'proposed' && a.status !== 'orphaned') continue;
      if (a.start === null) continue;
      const m = mapRange(a.start, a.end, ops);
      if (m.status === 'orphaned') {
        a.start = null; a.end = null; a.status = 'orphaned';
        this._event(d, 'annotation.orphaned', a.author, doc.id, { annotation: a.id });
      } else {
        a.start = m.start; a.end = m.end; a.status = 'proposed'; a.version = doc.version + 1;
      }
    }
  }

  // ---------- 遮罩预览（不落盘、不记录） ----------
  async previewMasks(docId, ids /* null=全部待确认 */, actor) {
    if (actor !== 'reviewer') throw httpError(403, '只有审阅人可以预览遮罩');
    return this.store.read(d => {
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      const anns = Object.values(d._ann || {}).filter(a =>
        a.docId === docId && a.kind === 'mask' && a.status === 'proposed' && a.start !== null &&
        (!ids || ids.includes(a.id)));
      // 从后往前替换，避免坐标移动；输出对外形态（无系统标记）
      let chars = codePoints(doc.content);
      const sorted = [...anns].sort((x, y) => y.start - x.start);
      for (const a of sorted) {
        chars = chars.slice(0, a.start).concat(codePoints('█'.repeat(a.end - a.start))).concat(chars.slice(a.end));
      }
      // 已确认块的标记也要剥离
      const preview = chars.filter(c => c !== MARK && c !== MARK_END).join('');
      // 受影响（会被封存）的批注
      const affected = Object.values(d._ann || {}).filter(a =>
        a.docId === docId && a.kind !== 'mask' && a.start !== null &&
        anns.some(m => a.start < m.end && a.end > m.start))
        .map(a => ({ id: a.id, kind: a.kind, status: a.status }));
      return {
        preview,
        masks: anns.map(a => ({ id: a.id, start: a.start, end: a.end, len: a.end - a.start })),
        seal: affected,
      };
    });
  }

  // ---------- 确认遮罩（不可逆） ----------
  async confirmMasks(docId, ids /* null=全部待确认 */, actor, expectedVersion) {
    if (actor !== 'reviewer') throw httpError(403, '只有审阅人可以确认遮罩');
    return this.store.tx(d => {
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      this._assertOpen(doc);
      this._assertVersion(doc, expectedVersion);
      const anns = Object.values(d._ann || {}).filter(a =>
        a.docId === docId && a.kind === 'mask' && a.status === 'proposed' && a.start !== null &&
        (!ids || ids.includes(a.id)));
      if (!anns.length) throw httpError(400, '没有可确认的遮罩提议');

      // 从后往前把正文文字换成遮罩块
      let content = doc.content;
      const sealed = [];
      const sorted = [...anns].sort((x, y) => y.start - x.start);
      // 逐个替换并重映射其他批注（遮罩块在 token diff 中是原子段）
      for (const a of sorted) {
        const chars = codePoints(content);
        const block = maskBlock(a.end - a.start);
        const next = chars.slice(0, a.start).join('') + block + chars.slice(a.end).join('');
        const ops = contentOpcodes(content, next);
        // 新遮罩块的区间：从 a.start 起，长度 = 块全长（含 ⟦ ⟧）
        const blockStart = a.start;
        const blockEnd = a.start + cpLen(block);
        for (const other of Object.values(d._ann || {}).filter(x => x.docId === docId && x.id !== a.id)) {
          if (other.start === null) continue;
          const m = mapRange(other.start, other.end, ops);
          if (other.status === 'sealed') {
            if (m.status === 'mapped') { other.start = m.start; other.end = m.end; }
            continue;
          }
          if (m.status === 'orphaned') {
            // 被本遮罩块吞掉的活动批注：封存，坐标贴到块上
            other.start = blockStart; other.end = blockEnd;
            other.note = null; other.replacement = null;
            other.status = 'sealed'; other.sealedReason = 'mask-overlap';
            sealed.push(other.id);
            this._event(d, 'annotation.sealed', actor, docId, { annotation: other.id, reason: 'mask-overlap' });
            continue;
          }
          // 映射成功后与新遮罩块相交（批注选区含块内部）也封存
          if (m.start < blockEnd && m.end > blockStart) {
            other.start = m.start; other.end = m.end;
            other.note = null; other.replacement = null;
            other.status = 'sealed'; other.sealedReason = 'mask-overlap';
            sealed.push(other.id);
            this._event(d, 'annotation.sealed', actor, docId, { annotation: other.id, reason: 'mask-overlap' });
          } else if (other.status === 'proposed' || other.status === 'orphaned') {
            other.start = m.start; other.end = m.end; other.version = doc.version + 1;
            if (other.status === 'orphaned') other.status = 'proposed';
          }
        }
        content = next;
        // 遮罩提议本身删除：历史里不保留它的选区文字，只留“遮罩 N 字”事件
        this._event(d, 'mask.confirmed', actor, docId, { len: a.end - a.start });
        delete d._ann[a.id];
      }

      doc.content = content;
      doc.version += 1;
      doc.updatedAt = new Date().toISOString();
      return { doc: this._docView(d, doc), sealed };
    });
  }

  _docView(d, doc) {
    return {
      id: doc.id, title: doc.title, content: doc.content,
      version: doc.version, status: doc.status,
      updatedAt: doc.updatedAt, closedAt: doc.closedAt,
      masks: extractMasks(doc.content),
    };
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { Service, httpError };
