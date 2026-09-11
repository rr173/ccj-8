'use strict';
// 业务逻辑：批注（可逆层）与遮罩（不可逆层）
//
// 不可逆遮罩的安全边界：
//  - 确认遮罩 = 直接把正文中的字替换成 ⟦██…⟧ 占位符，全文重写落盘；
//  - 不保存遮罩前快照、不保存被遮文字、不保存可还原的编码；
//  - 事件历史只记“遮罩 N 字”，批注若引用了被遮范围，其备注/替换文一律清空封存；
//  - 外部稿接口剥离标记，只给出可公开文本。

const {
  codePoints, contentOpcodes, mapRange, mapRangeLoose, maskBlock, extractMasks,
  validateAuthorEdit, cpLen, MARK, MARK_END, hashPassword, randomToken,
  mergeParagraphs, paragraphBounds,
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
      parentId: doc.parentId || null,
      released: (doc.releases || []).length,
      paragraphs: paragraphBounds(doc.content).length,
      derived: Object.values(d.docs).filter(x => x.parentId === doc.id).length,
    })));
  }

  async getDoc(id) {
    return this.store.read(d => (d.docs[id] ? this._docView(d, d.docs[id]) : null));
  }

  async createDoc(title, content, actor) {
    return this.store.tx(d => {
      const id = 'doc_' + (++d.counters.doc);
      const now = new Date().toISOString();
      const doc = {
        id, title, content, version: 1, status: 'open',
        createdAt: now, updatedAt: now, closedAt: null,
        parentId: null, baseContent: null, baseVersion: null, releases: [],
      };
      d.docs[id] = doc;
      d._ann = d._ann || {};
      this._event(d, 'doc.create', actor, id, { title });
      return doc;
    });
  }

  // ---------- 派生投放稿 ----------
  // 派生时与母稿同一份字：母稿已确认的遮罩块随正文一起复制（原文早已抹除，
  // 复制的内容里本来就没有），批注与历史不复制 —— 投放稿有自己的审阅空间。
  async deriveDoc(id, title, actor) {
    return this.store.tx(d => {
      const parent = d.docs[id];
      if (!parent) throw httpError(404, '文档不存在');
      const n = Object.values(d.docs).filter(x => x.parentId === id).length;
      const newId = 'doc_' + (++d.counters.doc);
      const now = new Date().toISOString();
      const doc = {
        id: newId,
        title: (title && String(title).slice(0, 200)) || `${parent.title}（投放稿 ${n + 1}）`,
        content: parent.content,
        version: 1, status: 'open',
        createdAt: now, updatedAt: now, closedAt: null,
        parentId: parent.id,
        baseContent: parent.content,   // 三方合并基准：母稿当前正文
        baseVersion: parent.version,
        releases: [],                  // 投放稿的对外放行按段独立记录，不随派生复制
      };
      d.docs[newId] = doc;
      this._event(d, 'doc.derived', actor, parent.id, { child: newId, title: doc.title });
      this._event(d, 'doc.create', actor, newId, { title: doc.title, derivedFrom: parent.id });
      return this._docView(d, doc);
    });
  }

  _childrenOf(d, id) {
    return Object.values(d.docs).filter(x => x.parentId === id);
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

  // ---------- 按段放行（仅投放稿、仅作者） ----------
  // 放行 = 把“当前这一段遮完后的字”拍成对外快照。没放行的段不会出现在对外稿里，
  // 服务端不会把它的原文发给任何人。放行只增不删：没有收回接口，同一段不能重复放行，
  // 外部能看到的字从此只会因新增遮罩而变少。
  async releaseParagraph(id, paragraphIndex, actor, expectedVersion) {
    if (actor !== 'author') throw httpError(403, '只有作者可以放行段落');
    if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) throw httpError(400, '段号错误');
    return this.store.tx(d => {
      const doc = d.docs[id];
      if (!doc) throw httpError(404, '文档不存在');
      if (!doc.parentId) throw httpError(400, '母稿整篇可公开；按段放行只适用于投放稿');
      this._assertVersion(doc, expectedVersion);
      const bounds = paragraphBounds(doc.content);
      if (paragraphIndex >= bounds.length) throw httpError(400, '段号超出范围');
      const [start, end] = bounds[paragraphIndex];
      // 同一段只能放行一次（位置重叠即拒绝；已经放行过的段不会再被点亮或刷新）
      for (const r of (doc.releases || [])) {
        if (r.start !== null && start < r.end && end > r.start) {
          throw httpError(409, '该段已经放行，不能重复放行或收回');
        }
      }
      doc.releases = doc.releases || [];
      d.counters.release = (d.counters.release || 0) + 1;
      const rid = 'rel_' + d.counters.release;
      const release = {
        id: rid,
        paragraphIndex,
        // 放行段在“放行时正文”中的段内坐标：baseStart/baseEnd（自放行起不变）；
        // releaseBase = 放行那一刻的整篇正文，只用于把后来的遮罩位置映射回放行时刻。
        // start/end/currentIndex 是该段在“当前正文”里的现位置（普通改文严格跟随）。
        baseStart: start, baseEnd: end,
        releaseBase: doc.content,
        start, end, currentIndex: paragraphIndex,
        anchor: codePoints(doc.content).slice(start, end).join(''),
        releasedBy: actor, releasedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      doc.releases.push(release);
      doc.version += 1;
      doc.updatedAt = new Date().toISOString();
      this._event(d, 'paragraph.released', actor, id, { release: rid, paragraph: paragraphIndex });
      return { doc: this._docView(d, doc), release: this._releaseView(release) };
    });
  }

  // 正文改动后重定位所有放行段（改原文 / 接受建议 / 段三方合并同步共用）。
  // 普通文字编辑走严格映射（宁丢不错位）：改动冲出该段就标记失去现位置（不再随
  // 当前段号排序，但快照本身不动、对外仍只少不多）。
  _remapReleases(doc, oldText, newText, loose) {
    if (!doc.releases || !doc.releases.length) return;
    const ops = contentOpcodes(oldText, newText);
    for (const r of doc.releases) {
      if (r.start === null) continue;
      const m = loose ? mapRangeLoose(r.start, r.end, ops) : mapRange(r.start, r.end, ops);
      if (!m || m.status === 'orphaned') {
        r.currentIndex = null;
      } else {
        r.start = m.start; r.end = m.end;
        r.currentIndex = this._indexOfOffset(newText, m.start);
      }
    }
  }

  // 某段新增遮罩后，把对应位置从该份所有放行记录里一并抹除（同一事务内完成，
  // 事件只记字数）。每次遮罩要抹三处，保证被遮的字在落盘文件里也无处可寻：
  //   1) doc.content（由调用方 _maskRangeInDoc / confirmMasks 完成）；
  //   2) 每条放行的对外快照 anchor（外面能看到的字）；
  //   3) 每条放行保存的“放行时整篇正文”releaseBase（位置映射用，也不能留原文）。
  // 两层宽松映射保证改过的段也逃不掉：
  //   遮罩前正文坐标 → releaseBase 坐标 → 裁进该放行段 [baseStart,baseEnd) →
  //   段内快照坐标。宽松映射贴删改块边界，裁切保证只遮对应这一处、不连坐他段。
  // 多区间的坐标漂移这样消除：先在 releaseBase 副本上从后往前一次性擦完所有命中
  // 区间，再用 old→new 的 diff 重定位段边界；段内 anchor 同理按最终坐标从后往前擦。
  // 本方法必须在 doc.content 已被改写成遮后形态之后调用。
  _scrubReleases(d, doc, oldContent, ranges, actor, sourceId) {
    if (!doc.releases || !doc.releases.length) return;
    const curOps = contentOpcodes(oldContent, doc.content);
    for (const r of doc.releases) {
      // 命中区间换算到 releaseBase 坐标（区间彼此不重叠或被宽松映射吸附，从后往前处理）
      const baseOps = contentOpcodes(oldContent, r.releaseBase);
      const hits = [];
      for (const range of ranges) {
        const m = mapRangeLoose(range.start, range.end, baseOps);
        if (m && m.end > m.start) hits.push(m);
      }

      if (hits.length) {
        // ③ releaseBase 整篇物理抹除：从后往前，每个区间只基于“当前最新文本”擦一次
        for (const h of hits.sort((a, b) => b.start - a.start)) {
          r.releaseBase = this._eraseTextRanges(r.releaseBase, [h]);
        }
        // 段在新 releaseBase 中的边界：用 old→新 的最终 diff 一次定位（避免手算偏移）
        const fin = mapRangeLoose(r.baseStart, r.baseEnd, contentOpcodes(oldContent, r.releaseBase));
        const [newBaseStart, newBaseEnd] = fin
          ? [fin.start, Math.max(fin.end, fin.start)]
          : [r.baseStart, r.baseEnd];

        // ② 对外快照：把命中区间裁进段内，换算成段内坐标后一次性从后往前擦
        const localHits = hits
          .map(h => [Math.max(h.start, r.baseStart) - r.baseStart, Math.min(h.end, r.baseEnd) - r.baseStart])
          .filter(([s, e]) => e > s && s >= 0)
          .sort((a, b) => b[0] - a[0]);
        const erased = this._eraseAnchorRanges(r, localHits);

        r.baseStart = newBaseStart;
        r.baseEnd = newBaseEnd;
        if (erased > 0) {
          this._event(d, 'release.scrubbed', actor, doc.id, { release: r.id, len: erased, source: sourceId || null });
        }
      }

      // ① 该段在“当前正文”里的现位置按遮罩宽松跟随（段内被遮也不丢排序位置）
      const cur = mapRangeLoose(r.start, r.end, curOps);
      if (cur) {
        r.start = cur.start; r.end = Math.max(cur.end, cur.start);
        r.currentIndex = this._indexOfOffset(doc.content, cur.start);
      } else {
        r.currentIndex = null;
      }
    }
  }

  // 把文本上若干区间（坐标互不重叠或从后往前处理无妨；调用方已从后往前排序）
  // 中非遮罩块的字符换成等长遮罩块，返回新文本。遮罩块是原子不可切。
  _eraseTextRanges(text, ranges) {
    let out = text;
    for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
      const spans = [];
      let cur = range.start;
      for (const m of extractMasks(out)) {
        if (m.end <= cur) continue;
        if (m.start >= range.end) break;
        if (m.start > cur) spans.push([cur, Math.min(m.start, range.end)]);
        cur = Math.max(cur, m.end);
      }
      if (cur < range.end) spans.push([cur, range.end]);
      for (let i = spans.length - 1; i >= 0; i--) {
        const [a, b] = spans[i];
        const chars = codePoints(out);
        out = chars.slice(0, a).join('') + maskBlock(b - a) + chars.slice(b).join('');
      }
    }
    return out;
  }

  // 在放行快照（单段内部坐标）上把若干区间中非遮罩块的字符抹成遮罩块。
  // 区间按从后往前处理：擦靠后的区间不会改变靠前区间的坐标。块是原子，跳过。
  // 返回抹掉的字数。
  _eraseAnchorRanges(r, ranges) {
    let erased = 0;
    for (const [s, e] of ranges) {
      if (e <= s) continue;
      // 扣除已存在遮罩块覆盖的部分，得到真正要擦的普通字符 span
      const spans = [];
      let cur = s;
      for (const m of extractMasks(r.anchor)) {
        if (m.end <= cur) continue;
        if (m.start >= e) break;
        if (m.start > cur) spans.push([cur, Math.min(m.start, e)]);
        cur = Math.max(cur, m.end);
      }
      if (cur < e) spans.push([cur, e]);
      for (let i = spans.length - 1; i >= 0; i--) {
        const [a, b] = spans[i];
        const chars = codePoints(r.anchor);
        r.anchor = chars.slice(0, a).join('') + maskBlock(b - a) + chars.slice(b).join('');
        erased += b - a;
      }
    }
    return erased;
  }

  // 单区间便捷封装
  _eraseAnchorRange(r, s, e) {
    return this._eraseAnchorRanges(r, [[s, e]]);
  }

  // code-point 偏移落在第几段（按换行计）
  _indexOfOffset(text, offset) {
    const chars = codePoints(text);
    let idx = 0;
    for (let i = 0; i < offset && i < chars.length; i++) if (chars[i] === '\n') idx++;
    return idx;
  }

  _releaseView(r) {
    return {
      id: r.id, paragraph: r.paragraphIndex,
      currentIndex: r.currentIndex,
      start: r.start, end: r.end,
      releasedBy: r.releasedBy, releasedAt: r.releasedAt,
      masks: extractMasks(r.anchor).length,
    };
  }

  // 对外稿（免登录）：
  //  - 母稿：保持整篇可公开（所有已确认遮罩呈现为 █）；
  //  - 投放稿：按段放行制。没有放行任何段时，外面看到的是完全空白——
  //    连段数、篇幅、换行都不泄露；只有作者逐段“放行”的段才会出现在对外稿里。
  //    每段呈现的是“放行快照”：放行那一刻遮完后的字；放行后新增的遮罩
  //    （本稿确认或随母稿同步）按位置映射进快照继续抹除，只会更少不会更多。
  async external(id) {
    return this.store.read(d => {
      const doc = d.docs[id];
      if (!doc) throw httpError(404, '文档不存在');
      if (!doc.parentId) {
        return this._externalFull(doc);
      }
      return this._externalReleased(d, doc);
    });
  }

  // 整篇对外（母稿）：剥离系统标记，遮罩块呈现为等长 █。
  _externalFull(doc) {
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
    return { id: doc.id, title: doc.title, status: doc.status, content: out, masks: ranges,
      released: null, closedAt: doc.closedAt };
  }

  // 按段放行的对外稿（投放稿）。
  _externalReleased(d, doc) {
    const rels = (doc.releases || []).slice().sort((a, b) => {
      const ia = a.currentIndex, ib = b.currentIndex;
      if (ia !== null && ib !== null && ia !== ib) return ia - ib;
      if (ia === null && ib !== null) return 1;   // 段已被改动、失去现位置的排在后
      if (ib === null && ia !== null) return -1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    const parts = [];
    const ranges = [];
    for (const r of rels) {
      const chars = codePoints(r.anchor);
      let text = '', oi = 0, i = 0;
      while (i < chars.length) {
        if (chars[i] === MARK) {
          let j = i + 1, n = 0;
          while (chars[j] === '█') { n++; j++; }
          if (chars[j] === MARK_END) {
            ranges.push({ start: oi, end: oi + n, len: n });
            text += '█'.repeat(n);
            oi += n; i = j + 1; continue;
          }
        }
        text += chars[i]; oi++; i++;
      }
      parts.push(text);
    }
    // 未放行任何段：空字符串。段与段之间用换行连接，不补发被省略段的空行。
    return { id: doc.id, title: doc.title, status: doc.status, content: parts.join('\n'),
      masks: ranges, released: rels.length, closedAt: doc.closedAt };
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
        if (replacement.includes(MARK) || replacement.includes(MARK_END)) {
          throw httpError(400, '替换文本不允许包含 ⟦ 或 ⟧ 字符');
        }
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
      const preEdit = doc.content;
      const chars = codePoints(doc.content);
      const next = chars.slice(0, a.start).join('') + a.replacement + chars.slice(a.end).join('');
      this._remapActive(d, doc, next, { skipAnnId: a.id });
      this._remapReleases(doc, preEdit, next, false);
      doc.content = next;
      doc.version += 1;
      doc.updatedAt = new Date().toISOString();
      a.status = 'accepted';
      a.resolvedBy = actor; a.resolvedAt = new Date().toISOString();
      // 建议本身成为历史；其坐标按替换段对齐（仅用于显示）
      a.start = a.start; a.end = a.start + cpLen(a.replacement);
      this._event(d, 'suggest.accepted', actor, docId, { annotation: annId, replacedLen: 0 });
      this._syncChildren(d, doc, actor);
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
      const preEdit = doc.content;
      this._remapActive(d, doc, content);
      this._remapReleases(doc, preEdit, content, false);
      doc.content = content;
      doc.version += 1;
      doc.updatedAt = new Date().toISOString();
      this._event(d, 'doc.edit', actor, docId, { fromVersion: doc.version - 1, toVersion: doc.version });
      this._syncChildren(d, doc, actor);
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
      const preMaskContent = doc.content;
      let content = preMaskContent;
      const sealed = [];
      const maskedRanges = []; // 被遮区段（遮罩前正文坐标）：只活在本事务内存里用于同步投放稿，不落盘
      const sorted = [...anns].sort((x, y) => y.start - x.start);
      for (const a of sorted) {
        const chars = codePoints(content);
        maskedRanges.push({ start: a.start, end: a.end });
        const block = maskBlock(a.end - a.start);
        const next = chars.slice(0, a.start).join('') + block + chars.slice(a.end).join('');
        const ops = contentOpcodes(content, next);
        // 遮罩提议本身删除：历史里不保留它的选区文字，只留“遮罩 N 字”事件
        delete d._ann[a.id];
        this._sealAndRemap(d, doc, ops, a.start, a.start + cpLen(block), actor, sealed);
        content = next;
        this._event(d, 'mask.confirmed', actor, docId, { len: a.end - a.start });
      }

      doc.content = content;
      doc.version += 1;
      doc.updatedAt = new Date().toISOString();
      // 本稿自己确认的遮罩：从已放行段的对外快照里抹掉（外面只能更少），
      // 并把被遮文字从放行记录保存的放行时刻正文中物理抹除（落盘不留原文）。
      this._scrubReleases(d, doc, preMaskContent, maskedRanges, actor, null);
      // 母稿确认的遮罩：所有已派生的投放稿跟着把对应的那一处遮掉（只向下传播，绝不写回）
      this._propagateMasks(d, doc, preMaskContent, maskedRanges, actor);
      return { doc: this._docView(d, doc), sealed };
    });
  }

  // 遮罩块落进正文后：与块重叠/被吞掉的批注一律封存（备注/替换文清空），
  // 其余批注按 diff 重定位。确认遮罩与母稿同步遮罩共用这一套。
  _sealAndRemap(d, doc, ops, blockStart, blockEnd, actor, sealedOut) {
    for (const other of Object.values(d._ann || {}).filter(x => x.docId === doc.id)) {
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
        if (sealedOut) sealedOut.push(other.id);
        this._event(d, 'annotation.sealed', actor, doc.id, { annotation: other.id, reason: 'mask-overlap' });
        continue;
      }
      // 映射成功后与新遮罩块相交（批注选区含块内部）也封存
      if (m.start < blockEnd && m.end > blockStart) {
        other.start = m.start; other.end = m.end;
        other.note = null; other.replacement = null;
        other.status = 'sealed'; other.sealedReason = 'mask-overlap';
        if (sealedOut) sealedOut.push(other.id);
        this._event(d, 'annotation.sealed', actor, doc.id, { annotation: other.id, reason: 'mask-overlap' });
      } else if (other.status === 'proposed' || other.status === 'orphaned') {
        other.start = m.start; other.end = m.end; other.version = doc.version + 1;
        if (other.status === 'orphaned') other.status = 'proposed';
      }
    }
  }

  // ---------- 母稿 → 投放稿：正文同步 ----------
  // 母稿正文变化（改原文/接受建议）→ 各投放稿按段三方合并：
  // 投放稿没改过的段跟着母稿变；投放稿自己改过的段保留，不被母稿盖掉。
  // 已冻结的投放稿不再同步文字（但遮罩仍强制同步，见 _propagateMasks）。
  _syncChildren(d, parent, actor) {
    for (const child of this._childrenOf(d, parent.id)) {
      if (child.status !== 'open') continue;
      const merged = mergeParagraphs(child.baseContent, parent.content, child.content);
      child.baseContent = parent.content;
      child.baseVersion = parent.version;
      if (merged === child.content) continue;
      const childBefore = child.content;
      this._remapActive(d, child, merged);
      this._remapReleases(child, childBefore, merged, false);
      child.content = merged;
      child.version += 1;
      child.updatedAt = new Date().toISOString();
      this._event(d, 'doc.sync', actor, child.id, {
        fromVersion: child.version - 1, toVersion: child.version, source: parent.id,
      });
      this._syncChildren(d, child, actor); // 级联：投放稿的投放稿
    }
  }

  // ---------- 母稿 → 投放稿：遮罩强制同步 ----------
  // 母稿确认遮罩 → 所有投放稿（含已冻结的）必须把对应的那一处遮掉。
  // 按“位置对应”同步：把母稿遮罩区段（遮罩前正文坐标）用 token 级 diff 映射进
  // 投放稿正文——投放稿把那一段改写过的也照遮（对外一个字都读不到），同时只遮
  // 对应的这一处，文中其他相同的字不被连坐。只向下，不写回母稿。
  // ranges 使用 parentOldContent（母稿遮罩前正文）的坐标；级联时换算成各投放稿
  // 自己遮罩前的坐标逐层向下传。
  _propagateMasks(d, parent, parentOldContent, ranges, actor) {
    for (const child of this._childrenOf(d, parent.id)) {
      const childOld = child.content;
      const ops = contentOpcodes(parentOldContent, childOld);
      const mapped = [];
      for (const r of ranges) {
        const m = mapRangeLoose(r.start, r.end, ops);
        if (m && m.end > m.start) mapped.push(m);
      }
      let changed = false;
      for (const m of mapped.sort((a, b) => b.start - a.start)) {
        if (this._maskRangeInDoc(d, child, m.start, m.end, actor, parent.id)) changed = true;
      }
      // 母稿新遮罩向下同步后，这份投放稿已放行的段也要在“放行那一刻”的快照上
      // 把对应的那处抹掉——外面能读到的字只会更少，改过的段也按位置照遮。
      this._scrubReleases(d, child, childOld, mapped, actor, parent.id);
      child.baseContent = parent.content;
      child.baseVersion = parent.version;
      if (changed) {
        child.version += 1;
        child.updatedAt = new Date().toISOString();
      }
      this._propagateMasks(d, child, childOld, mapped, actor); // 级联：投放稿的投放稿
    }
  }

  // 把 doc 正文 [start,end) 这一段换成遮罩块（已确认遮罩块覆盖的部分除外，
  // 块是原子不能切）；重叠批注封存、其余批注重定位。与母稿确认同一事务执行，
  // 落盘不留被遮文字副本。
  _maskRangeInDoc(d, doc, start, end, actor, sourceId) {
    if (end <= start) return false;
    // 扣除已确认遮罩块覆盖的部分
    const spans = [];
    let cur = start;
    for (const m of extractMasks(doc.content)) {
      if (m.end <= cur) continue;
      if (m.start >= end) break;
      if (m.start > cur) spans.push([cur, Math.min(m.start, end)]);
      cur = Math.max(cur, m.end);
    }
    if (cur < end) spans.push([cur, end]);
    // 从后往前替换，避免坐标移动
    let erased = 0;
    for (let i = spans.length - 1; i >= 0; i--) {
      const [s, e] = spans[i];
      const before = doc.content;
      const chars = codePoints(before);
      const block = maskBlock(e - s);
      doc.content = chars.slice(0, s).join('') + block + chars.slice(e).join('');
      this._sealAndRemap(d, doc, contentOpcodes(before, doc.content), s, s + cpLen(block), actor, null);
      erased += e - s;
    }
    if (erased) {
      this._event(d, 'mask.synced', actor, doc.id, { len: erased, count: spans.length, source: sourceId });
    }
    return erased > 0;
  }

  _docView(d, doc) {
    const parent = doc.parentId ? d.docs[doc.parentId] : null;
    return {
      id: doc.id, title: doc.title, content: doc.content,
      version: doc.version, status: doc.status,
      updatedAt: doc.updatedAt, closedAt: doc.closedAt,
      masks: extractMasks(doc.content),
      parentId: doc.parentId || null,
      baseVersion: doc.baseVersion || null,
      paragraphs: paragraphBounds(doc.content).map(([start, end]) => ({ start, end })),
      releases: (doc.releases || []).map(r => this._releaseView(r)),
      parent: parent ? { id: parent.id, title: parent.title } : null,
      derived: this._childrenOf(d, doc.id).map(x => ({ id: x.id, title: x.title, status: x.status })),
    };
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { Service, httpError };
