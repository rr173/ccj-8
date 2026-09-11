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
  validateAuthorEdit, cpLen, MARK, MARK_END, hashPassword, randomToken, sha256Hex,
  mergeParagraphs, paragraphBounds, diffOpcodes,
} = require('./util');

class Service {
  constructor(store) {
    this.store = store;
  }

  // ---------- 初始化 ----------
  // 两名审阅人：不可逆遮罩必须由两个不同的审阅人各自点头，一个人说了不算。
  async initUsers(authorPw, reviewerPw, reviewer2Pw) {
    await this.store.tx(d => {
      if (!d.secret) d.secret = randomToken();
      if (!d.users.author) d.users.author = { passHash: hashPassword(authorPw), role: 'author' };
      if (!d.users.reviewer) d.users.reviewer = { passHash: hashPassword(reviewerPw), role: 'reviewer' };
      if (!d.users.reviewer2) d.users.reviewer2 = { passHash: hashPassword(reviewer2Pw), role: 'reviewer' };
    });
    return this.store.read(d => d.secret);
  }

  getUser(username) {
    return this.store.read(d => d.users[username] || null);
  }

  // actor 是用户名；遮罩/批注权限看角色（reviewer / reviewer2 都是审阅人）
  _isReviewer(d, actor) {
    return !!(d.users[actor] && d.users[actor].role === 'reviewer');
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
      callbacks: ((d.callbacks && d.callbacks[doc.id]) || []).length,
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
        parentId: null, baseContent: null, baseVersion: null, releases: [], recalls: [],
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
        recalls: [],                   // 渠道召回令同样按份独立，不随派生复制
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
  //   1) doc.content（由调用方 _maskRangeInDoc / _applyConfirmedMasks 完成）；
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

  // ---------- 渠道召回令（仅投放稿、仅作者；只追加、不可撤销/重复） ----------
  // 作者对某一份投放稿、某一个渠道下召回令，点名“已经放行出去”的若干段。下了令之后：
  //   - 这个渠道再看这份（external 带 channel），被点名的段必须是空的，原文翻不出来；
  //     没被点名的渠道看同一份，还按原来放行的看（召回按渠道隔离，互不连坐）；
  //   - 这个渠道再把发出去的字送回（registerCallback），若还带着被召回的段，
  //     在这笔不可改的账上记一笔【拒不召回】，再送一次也抹不掉（账只追加）。
  // 约束：
  //   - 没放行过的段写不进召回令（点名段必须能解析到一条放行记录）；
  //   - 同一渠道对同一段（同一条放行）只能召回一次；
  //   - 召回不改正文、不动放行快照、也不把已经抹掉的字救回来——只是该渠道看不到。
  async recallParagraphs(docId, channel, paragraphIndexes, actor, expectedVersion) {
    if (actor !== 'author') throw httpError(403, '只有作者可以下渠道召回令');
    const chan = normalizeChannel(channel);
    if (!chan) throw httpError(400, '必须写明渠道');
    if (!Array.isArray(paragraphIndexes) || !paragraphIndexes.length) {
      throw httpError(400, '必须写明召回哪几段');
    }
    const idxs = [];
    for (const p of paragraphIndexes) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0) throw httpError(400, '段号错误');
      if (!idxs.includes(n)) idxs.push(n);
    }
    return this.store.tx(d => {
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      if (!doc.parentId) throw httpError(400, '召回令只对投放稿生效（母稿整篇对外，无按段放行口径）');
      this._assertVersion(doc, expectedVersion);

      const existing = new Set((doc.recalls || []).filter(o => o.channel === chan).flatMap(o => o.releaseIds));
      const picked = [];
      for (const idx of idxs) {
        const hit = (doc.releases || []).filter(r => r.currentIndex === idx);
        if (!hit.length) {
          throw httpError(400, `第 ${idx + 1} 段没有放行记录，写不进召回令`);
        }
        if (hit.length > 1) {
          throw httpError(409, `第 ${idx + 1} 段对应多条放行快照，请刷新后重试`);
        }
        const r = hit[0];
        if (existing.has(r.id)) throw httpError(409, `渠道「${chan}」对第 ${idx + 1} 段已经召回过，不能重复召回`);
        picked.push({ release: r, idx });
      }

      doc.recalls = doc.recalls || [];
      d.counters.recall = (d.counters.recall || 0) + 1;
      const id = 'rc_' + d.counters.recall;
      const now = new Date().toISOString();
      const order = {
        id, docId, channel: chan,
        releaseIds: picked.map(x => x.release.id),
        paragraphs: picked.map(x => x.idx),
        at: now, by: actor,
      };
      doc.recalls.push(order);
      doc.version += 1;
      doc.updatedAt = now;
      this._event(d, 'paragraph.recalled', actor, docId, {
        recall: id, channel: chan, paragraphs: order.paragraphs.map(i => i + 1), count: order.paragraphs.length,
      });
      return { doc: this._docView(d, doc), order: this._recallView(order) };
    });
  }

  _recallView(o) {
    return { id: o.id, channel: o.channel, paragraphs: o.paragraphs, count: o.paragraphs.length, by: o.by, at: o.at };
  }

  // 该渠道被点名召回的放行记录
  _recalledReleases(doc, channel) {
    const ids = new Set((doc.recalls || []).filter(o => o.channel === channel).flatMap(o => o.releaseIds));
    return (doc.releases || []).filter(r => ids.has(r.id));
  }

  // 查这份对哪个渠道召回过哪几段、有没有拒不召回（读账计算；账只追加所以永不过期）。
  // 可带 channel 只看某渠道。
  async recallLedger(docId, channel) {
    return this.store.read(d => {
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      const chanFilter = channel ? normalizeChannel(channel) : null;
      let orders = (doc.recalls || []).map(o => this._recallView(o));
      if (chanFilter) orders = orders.filter(o => o.channel === chanFilter);

      const cbs = (d.callbacks && d.callbacks[docId]) || [];
      const byChannel = {};
      for (const o of orders) {
        const g = byChannel[o.channel] || (byChannel[o.channel] = {
          channel: o.channel, recallCount: 0, recalledParagraphs: [],
          refusalCallbacks: 0, refusals: [],
        });
        g.recallCount += o.count;
        for (const p of o.paragraphs) if (!g.recalledParagraphs.includes(p)) g.recalledParagraphs.push(p);
      }
      // 拒不召回记在回传账上（只追加）：逐笔汇总进对应渠道
      for (const c of cbs) {
        if (chanFilter && c.channel !== chanFilter) continue;
        if (!c.refusals || !c.refusals.length) continue;
        const g = byChannel[c.channel] || (byChannel[c.channel] = {
          channel: c.channel, recallCount: 0, recalledParagraphs: [],
          refusalCallbacks: 0, refusals: [],
        });
        g.refusalCallbacks += 1;
        for (const rf of c.refusals) {
          g.refusals.push({ callback: c.id, seq: c.seq, paragraph: rf.paragraph, at: c.at });
          if (!g.recalledParagraphs.includes(rf.paragraph)) g.recalledParagraphs.push(rf.paragraph);
        }
      }
      for (const g of Object.values(byChannel)) {
        g.recalledParagraphs.sort((a, b) => a - b);
      }
      return {
        docId,
        channel: chanFilter,
        count: orders.length,
        orders,
        channels: Object.values(byChannel).map(g => ({
          channel: g.channel,
          recallOrders: orders.filter(o => o.channel === g.channel).length,
          recalledParagraphs: g.recalledParagraphs,
          refusalCallbacks: g.refusalCallbacks,
          refusalCount: g.refusals.length,
          refusals: g.refusals,
        })),
      };
    });
  }

  // 对外稿（免登录）：
  //  - 母稿：保持整篇可公开（所有已确认遮罩呈现为 █）；
  //  - 投放稿：按段放行制。没有放行任何段时，外面看到的是完全空白——
  //    连段数、篇幅、换行都不泄露；只有作者逐段“放行”的段才会出现在对外稿里。
  //    每段呈现的是“放行快照”：放行那一刻遮完后的字；放行后新增的遮罩
  //    （本稿确认或随母稿同步）按位置映射进快照继续抹除，只会更少不会更多。
  //  - 召回令按渠道生效：带 channel 时，作者已对该渠道点名召回的放行段从视图里
  //    整段抽掉（该渠道这几段必须是空的）；没被点名的渠道（或不带 channel）
  //    仍按原来放行的看。召回不抹快照原文，只是该渠道读不到。
  async external(id, channel) {
    return this.store.read(d => {
      const doc = d.docs[id];
      if (!doc) throw httpError(404, '文档不存在');
      const chan = channel ? normalizeChannel(channel) : null;
      if (!doc.parentId) {
        return this._externalFull(doc, chan);
      }
      return this._externalReleased(d, doc, chan);
    });
  }

  // 整篇对外（母稿）：剥离系统标记，遮罩块呈现为等长 █。母稿没有按段放行/召回口径。
  _externalFull(doc, channel) {
    void channel;
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

  // 按段放行的对外稿（投放稿）。channel 非空时按渠道召回令抽段：该渠道被点名
  // 召回的放行段不进入拼接结果，于是“这个渠道再看这份，这几段必须是空的”；
  // 没被点名的渠道与不带渠道的公开口径仍按原来放行的看。
  // 返回里保留 parts（每段 {release,index,text}），回传对账要逐段判定在场与否。
  _externalParts(d, doc, channel) {
    const recalledIds = new Set((doc.recalls || [])
      .filter(o => o.channel === channel)
      .flatMap(o => o.releaseIds));
    const rels = (doc.releases || []).slice().sort((a, b) => {
      const ia = a.currentIndex, ib = b.currentIndex;
      if (ia !== null && ib !== null && ia !== ib) return ia - ib;
      if (ia === null && ib !== null) return 1;   // 段已被改动、失去现位置的排在后
      if (ib === null && ia !== null) return -1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    const parts = [];
    for (const r of rels) {
      if (channel && recalledIds.has(r.id)) continue;
      const chars = codePoints(r.anchor);
      let text = '', i = 0;
      while (i < chars.length) {
        if (chars[i] === MARK) {
          let j = i + 1, n = 0;
          while (chars[j] === '█') { n++; j++; }
          if (chars[j] === MARK_END) {
            text += '█'.repeat(n);
            i = j + 1; continue;
          }
        }
        text += chars[i]; i++;
      }
      parts.push({ release: r.id, index: r.paragraphIndex, text });
    }
    return parts;
  }

  _externalReleased(d, doc, channel) {
    const parts = this._externalParts(d, doc, channel || null);
    // 各段用换行连接，不补发被省略/未放行/被召回段的空行；遮罩区间按拼接位置平移
    const ranges = [];
    const texts = [];
    let base = 0;
    for (const p of parts) {
      for (const m of p.text.matchAll(/█+/g)) {
        ranges.push({ start: base + m.index, end: base + m.index + m[0].length, len: m[0].length });
      }
      texts.push(p.text);
      base += p.text.length + 1;
    }
    // 未放行任何段（或可见段都被该渠道召回）：空字符串，不泄露段数与篇幅
    return { id: doc.id, title: doc.title, status: doc.status, content: texts.join('\n'),
      masks: ranges, released: (doc.releases || []).length,
      visible: parts.length, channel: channel || null, closedAt: doc.closedAt };
  }

  // ---------- 渠道回传记账（只追加、永不修改/抹除） ----------
  // 渠道把“实际发出去的字”回传回来，必须对着某一份投放稿、写明渠道。拿回传跟
  // 这一份【此刻外面能看见的字】（external() 的结果）对：
  //   - 一字不差才算干净（clean）；
  //   - 回传里出现了外面已经看不见的字（外面没有的字/被遮罩抹去的字/旧稿字）：
  //     记一笔【泄露】；
  //   - 回传比外面少了【整段】已经能看见的段：记一笔【少发】（段内缺字属对不上，
  //     记泄露，不记少发——少发按“整段”口径）。
  // 记账只追加：同一渠道对同一份可以再回传，每次单独记账；已经记下的泄露/少发
  // 不能改、也不能靠再回传一次抹掉。回传不改内部正文，也不能把抹掉的字救回来：
  // 回传里多出来的“泄露的字”不按原文落盘，只存字数 + SHA-256 指纹，原始的字只在
  // 本次响应里返回给记账人看一眼，落盘文件里依然搜不到。
  // 外面还看不见任何字的投放稿（未放行任何段），不收回传。
  async registerCallback(docId, channel, content, actor) {
    if (actor !== 'author') throw httpError(403, '只有作者可以登记渠道回传');
    const chan = normalizeChannel(channel);
    if (!chan) throw httpError(400, '必须写明渠道');
    if (typeof content !== 'string') throw httpError(400, '回传内容必须是文本');
    return this.store.tx(d => {
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      if (!doc.parentId) throw httpError(400, '渠道回传只对投放稿登记（母稿整篇对外，无按段放行口径）');

      // 全量对外口径（按召回前的放行）：只要整份外面还看得见字就收这笔回传；
      // 某渠道把可见段全召回后，该渠道自己的视图为空——仍要收空回传（不能把
      // “拒不召回”的账门也关上）。
      const fullExt = this._externalReleased(d, doc, null);
      if (fullExt.content === '') {
        throw httpError(409, '这一份还没有任何对外可见的字（未放行段落），不能收回传');
      }

      const received = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      // 该渠道此刻外面能看见的字：被点名召回的段对该渠道必须是空的。
      const chanExt = this._externalReleased(d, doc, chan);
      // 对账分两层，互不连坐：
      //   1) 跟【该渠道视图】对 → 常规的干净 / 泄露 / 少发（没被点名召回的段照常）；
      //   2) 跟【全量视图】对，只看“该渠道被召回的段”是否还被送回来 → 拒不召回。
      const verdict = this._reconcileCallback(chanExt.content, received);
      const fullVerdict = this._reconcileCallback(fullExt.content, received);

      // 被点名召回的放行段：按全量视图里的段号取回在场判定；全 █ 段没有可见字
      // 可作“原文还带着”的证据（本就读不到原文），不计拒不召回。
      const recalledIdx = new Set((doc.recalls || [])
        .filter(o => o.channel === chan)
        .flatMap(o => o.paragraphs));
      const refusals = [];
      for (const idx of recalledIdx) {
        const pres = fullVerdict.presence[idx];
        if (pres && pres.visible > 0 && pres.visibleExact / pres.visible >= 0.5) {
          refusals.push({ paragraph: idx, chars: pres.visible });
        }
      }

      d.callbacks = d.callbacks || {};
      d.callbacks[docId] = d.callbacks[docId] || [];
      d.counters.callback = (d.counters.callback || 0) + 1;
      const id = 'cb_' + d.counters.callback;
      const sameChan = d.callbacks[docId].filter(c => c.channel === chan);
      const record = {
        id,
        docId,
        channel: chan,
        seq: sameChan.length + 1,   // 该渠道对这一份是第几次回传
        at: new Date().toISOString(),
        by: actor,
        chars: cpLen(received),
        clean: verdict.clean && refusals.length === 0,
        leak: {
          count: verdict.leaks.length,
          chars: verdict.leakChars,
          // 每处泄露片段只存指纹，不存字——回传不能把抹掉的字救回落盘文件
          items: verdict.leaks.map(f => ({ len: cpLen(f), sha256: sha256Hex(f) })),
        },
        missing: verdict.missing,
        refusals,   // 拒不召回：只追加、不可改、再送一次也抹不掉（只存段号/字数）
        externalLen: cpLen(chanExt.content),
      };
      d.callbacks[docId].push(record);
      this._event(d, 'callback.recorded', actor, docId, {
        callback: id, channel: chan, seq: record.seq,
        clean: record.clean, leakCount: record.leak.count, leakChars: record.leak.chars,
        missing: record.missing.length, refusal: refusals.length,
      });
      // 原始“泄露的字”只随本次响应返回，不进记录、不落盘
      return {
        callback: this._callbackView(record),
        leakFragments: verdict.clean ? [] : verdict.leaks,
        missingParagraphs: verdict.missing,
        refusals,
      };
    });
  }

  // 拿“外面此刻能看见的字” externalText 对“渠道实际发出的字” received：
  // 用 code-point 级 diff（遮罩位置在对外稿里已是 █，与普通字一样逐字对）。
  // 返回 { clean, leaks:[多出/对不上的片段], leakChars, missing:[整段没发的段],
  //         presence:{ 段号: {visible,visibleExact,masked,maskedFilled} } }。
  // 保守口径：顺序对不上（如整段调换）按“对不上 → 泄露”，不放过任何外面没有的字。
  // 少发只认“整段没发”：段里可见的字有一半以上被逐字照发（equal）才算同一段
  // 还在；把已遮代号按原文送回时，上下文可见字全部 equal、只有 █ 是 replace，于是
  // 只标泄露、绝不记整段少发。整段没发/换成不相干的字时可见字对不上 equal，才记少发。
  _reconcileCallback(externalText, received) {
    const extChars = codePoints(externalText);
    const rcvChars = codePoints(received);
    const ops = diffOpcodes(extChars, rcvChars);
    const leakRanges = [];   // received 坐标里“外面没有”的区间
    // 每个对外字的下场：'eq' 照发 | 'rep' 发了对不上的字 | 'del' 没发 | null 未覆盖
    const cover = new Array(extChars.length).fill(null);
    for (const [tag, i1, i2, j1, j2] of ops) {
      if (tag === 'insert') {
        leakRanges.push([j1, j2]);
      } else if (tag === 'replace') {
        leakRanges.push([j1, j2]);
        for (let k = i1; k < i2; k++) cover[k] = 'rep';
      } else if (tag === 'delete') {
        for (let k = i1; k < i2; k++) cover[k] = 'del';
      } else { // equal
        for (let k = i1; k < i2; k++) cover[k] = 'eq';
      }
    }
    const leaks = leakRanges.map(([a, b]) => rcvChars.slice(a, b).join('')).filter(s => s.length);
    const leakChars = leaks.reduce((n, s) => n + cpLen(s), 0);

    // 按换行切段，判定每段“在不在”。同一段在不在，看它【外面可见的字】（非 █）
    // 有多少被【逐字照发】（equal）——这是“同一段还在”的唯一硬证据：
    //   · 把已遮代号按原文送回时，段内可见的上下文（如“代号…是机密”）全部 equal，
    //     只有 █ 那截是 replace → 段在场，replace 只产生泄露，绝不记少发；
    //   · 整段没发/换成一段不相干的字时，可见字几乎对不上 equal（可能只蹭到句号
    //     这类零散同字）→ 达不到一半，记整段少发。
    // 被遮的 █ 本来外面就读不到，不计入“在场”分母，也不因其空缺记少发；只有整段
    // 全是遮罩、没有可见字可作锚时，才看每个 █ 是否都被按别的字填回（填回=在场，
    // 同时记泄露；什么都没发=整段少发）。
    const RATIO = 0.5;
    const missing = [];
    const presence = {};
    let pStart = 0, pIdx = 0;
    for (let i = 0; i <= extChars.length; i++) {
      if (i !== extChars.length && extChars[i] !== '\n') continue;
      const len = i - pStart;
      if (len > 0) {
        let visible = 0, visibleExact = 0, masked = 0, maskedFilled = 0;
        for (let k = pStart; k < i; k++) {
          if (extChars[k] === '█') {
            masked++;
            if (cover[k] === 'rep') maskedFilled++;
          } else {
            visible++;
            if (cover[k] === 'eq') visibleExact++;
          }
        }
        presence[pIdx] = { visible, visibleExact, masked, maskedFilled };
        const present = visible > 0
          ? visibleExact / visible >= RATIO
          : maskedFilled === masked;
        if (!present) missing.push({ index: pIdx, len });
      }
      pStart = i + 1; pIdx++;
    }

    const clean = leakRanges.length === 0 && missing.length === 0;
    return { clean, leaks, leakChars, missing, presence };
  }

  _callbackView(c) {
    return {
      id: c.id, channel: c.channel, seq: c.seq, at: c.at, by: c.by,
      chars: c.chars, externalLen: c.externalLen,
      clean: c.clean,
      leak: { count: c.leak.count, chars: c.leak.chars, items: c.leak.items },
      missing: c.missing,
      refusals: c.refusals || [],
    };
  }

  // 查某一份各渠道的回传：回过几次、每笔是否有泄露/少发（可按渠道过滤）。
  async callbacks(docId, channel) {
    return this.store.read(d => {
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      const all = (d.callbacks && d.callbacks[docId]) || [];
      const chan = channel ? normalizeChannel(channel) : null;
      if (chan && !all.some(c => c.channel === chan)) {
        throw httpError(404, '该渠道没有对这一份回过传');
      }
      const list = (chan ? all.filter(c => c.channel === chan) : all).map(c => this._callbackView(c));
      return { docId, channel: chan, count: list.length, callbacks: list, summary: this._callbackSummary(list) };
    });
  }

  _callbackSummary(list) {
    const byChannel = {};
    for (const c of list) {
      const s = byChannel[c.channel] || (byChannel[c.channel] =
        { channel: c.channel, count: 0, leakCallbacks: 0, missingCallbacks: 0,
          refusalCallbacks: 0, refusalCount: 0, leakChars: 0, clean: 0 });
      s.count += 1;
      if (c.leak.count > 0) s.leakCallbacks += 1;
      if (c.missing.length > 0) s.missingCallbacks += 1;
      if (c.refusals && c.refusals.length) {
        s.refusalCallbacks += 1;
        s.refusalCount += c.refusals.length;
      }
      s.leakChars += c.leak.chars;
      if (c.clean) s.clean += 1;
    }
    return Object.values(byChannel);
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
    if (a.kind === 'mask') {
      // 遮罩提议只暴露“谁在这处点了头”，绝不暴露被遮文字（covered 仍由正文实时截取）
      return {
        ...base,
        note: '', replacement: null,
        nods: (a.nods || []).map(n => ({ by: n.by, at: n.at })),
        approvers: (a.nods || []).map(n => n.by),
        voidReason: a.voidReason || null,
        covered: (a.start !== null && doc) ? codePoints(doc.content).slice(a.start, a.end).join('') : null,
      };
    }
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
    if (!['comment', 'suggest'].includes(kind)) throw httpError(400, '批注类型错误（遮罩请用双人点头接口 /masks/nod）');
    if (note && note.length > 2000) throw httpError(400, '备注过长');
    return this.store.tx(d => {
      if (!this._isReviewer(d, actor)) throw httpError(403, '只有审阅人可以添加批注');
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      this._assertOpen(doc);
      this._assertVersion(doc, expectedVersion);
      this._checkRange(doc, start, end);
      for (const m of extractMasks(doc.content)) {
        if (start < m.end && end > m.start) throw httpError(400, '选区与已确认遮罩重叠');
      }
      if (kind === 'suggest') {
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
    return this.store.tx(d => {
      if (!this._isReviewer(d, actor)) throw httpError(403, '只有审阅人可以重新定位批注');
      const doc = d.docs[docId];
      const a = d._ann && d._ann[annId];
      if (!doc || !a || a.docId !== docId) throw httpError(404, '批注不存在');
      if (a.kind === 'mask') throw httpError(400, '遮罩点头已随改文作废，不能移动旧选区；请在当前正文上重新划遮罩点头');
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
      if (a.kind === 'mask') {
        // 遮罩点头是双人不可逆授权：作者改过这段字（选区内部有任何增/删/改，
        // 或贴着选区边界加字——新字会挂在遮罩边上、旧选区遮不到它），点头立即
        // 作废——绝不能拿改之前的选区去遮现在的正文（否则会遮住审阅人没看过的
        // 新字、或对错位置）。只有编辑全在选区外（不贴边界）才保留，并按 diff
        // 移到新坐标。
        if (m.status === 'orphaned' || !this._maskRangeUntouched(a.start, a.end, ops)) {
          a.start = null; a.end = null;
          a.status = 'void'; a.voidReason = 'content-changed';
          this._event(d, 'mask.voided', a.author, doc.id, { annotation: a.id, reason: 'content-changed' });
        } else {
          a.start = m.start; a.end = m.end; a.version = doc.version + 1;
        }
        continue;
      }
      if (m.status === 'orphaned') {
        a.start = null; a.end = null; a.status = 'orphaned';
        this._event(d, 'annotation.orphaned', a.author, doc.id, { annotation: a.id });
      } else {
        a.start = m.start; a.end = m.end; a.status = 'proposed'; a.version = doc.version + 1;
      }
    }
  }

  // 遮罩选区 [start,end) 内部是否“一个字都没被动过”：
  //  - delete/replace 的旧文本跨度只要与选区相交（i2>start && i1<end）即被动过；
  //  - insert 落在选区内部、或恰好贴在 start/end 边界上（start<=i1<=end）都算动过——
  //    贴着边界加的字会直接挂在这串字边上，旧选区遮不到它：若放行，第二人按旧
  //    范围点齐后，新字就挂在遮罩边上（前面被遮、后加的字漏在外面）；
  //  - 贴着边界的 replace 若净增了字（新文本比旧文本长），等价于在字串边上
  //    加字，同样算动过；纯删除、等长替换邻居字不算加字，点头随 diff 平移保留。
  _maskRangeUntouched(start, end, ops) {
    for (const [tag, i1, i2, j1, j2] of ops) {
      if (tag === 'equal') continue;
      if (tag === 'insert') {
        if (i1 >= start && i1 <= end) return false;
      } else if (i2 > start && i1 < end) {
        return false;
      } else if (tag === 'replace' && (i2 === start || i1 === end) && (j2 - j1) > (i2 - i1)) {
        return false;
      }
    }
    return true;
  }

  // ---------- 遮罩预览（不落盘、不记录） ----------
  async previewMasks(docId, ids /* null=全部待确认 */, actor) {
    return this.store.read(d => {
      if (!this._isReviewer(d, actor)) throw httpError(403, '只有审阅人可以预览遮罩');
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
        masks: anns.map(a => ({
          id: a.id, start: a.start, end: a.end, len: a.end - a.start,
          approvers: (a.nods || []).map(n => n.by),
        })),
        seal: affected,
      };
    });
  }

  // ---------- 遮罩点头（双人确认制） ----------
  // 不可逆遮罩不能一个人说了算：审阅人在当前正文上划一处选区 = 一次“点头”。
  //   - 同一处必须有【两个不同审阅人】、且两人选区【完全一致】，遮罩才在本次
  //     点头的同一事务里落盘生效；只有一个人点过 / 两人范围对不上，正文一个字
  //     都不动，对外仍能读到。
  //   - 一个人已经点了之后，作者改了这段字：该点头立即作废（_remapActive 处理），
  //     不能拿改之前的选区来遮现在的正文；作废后需对当前正文重新划、重新点。
  async maskNod(docId, start, end, actor, expectedVersion) {
    return this.store.tx(d => {
      if (!this._isReviewer(d, actor)) throw httpError(403, '只有审阅人可以点头遮罩');
      const doc = d.docs[docId];
      if (!doc) throw httpError(404, '文档不存在');
      this._assertOpen(doc);
      this._assertVersion(doc, expectedVersion);
      this._checkRange(doc, start, end);
      if (end - start < 1) throw httpError(400, '遮罩至少覆盖 1 个字');
      for (const m of extractMasks(doc.content)) {
        if (start < m.end && end > m.start) throw httpError(400, '选区与已确认遮罩重叠');
      }
      const nowIso = new Date().toISOString();
      const pending = Object.values(d._ann || {}).filter(a =>
        a.docId === docId && a.kind === 'mask' && a.status === 'proposed' && a.start !== null);

      // 同一审阅人对同一处重复点头：幂等返回，不算第二人
      const mine = pending.find(a => a.author === actor && a.start === start && a.end === end);
      if (mine) {
        return { doc: this._docView(d, doc), annotation: this._publicAnnotation(d, docId, mine),
          outcome: 'already-nodded', applied: false };
      }

      // 另一个审阅人已就【完全一致】的选区点过头 → 点齐，本事务内立即不可逆遮罩
      const mate = pending.find(a => a.author !== actor && a.start === start && a.end === end);
      if (mate) {
        const nods = [
          { by: mate.author, at: mate.createdAt },
          { by: actor, at: nowIso },
        ];
        const len = end - start;
        const result = this._applyConfirmedMasks(d, doc, [{ start, end, nods }], actor);
        this._event(d, 'mask.confirmed', actor, docId, { len, approvers: nods.map(n => n.by) });
        return { ...result, outcome: 'confirmed', applied: true };
      }

      // 没有点齐：登记/刷新本审阅人的点头，正文一字不动（外面照常读得到）
      const myOther = pending.find(a => a.author === actor && start < a.end && end > a.start);
      let ann;
      if (myOther) {
        // 同一审阅人改划了与自己旧点头重叠的范围：旧点头撤下、以新选区为准
        myOther.start = null; myOther.end = null;
        myOther.status = 'void'; myOther.voidReason = 'superseded';
        this._event(d, 'mask.voided', actor, docId, { annotation: myOther.id, reason: 'superseded' });
      }
      d._ann = d._ann || {};
      const id = 'ann_' + (++d.counters.ann);
      ann = {
        id, docId, kind: 'mask', status: 'proposed',
        start, end, version: doc.version,
        note: '', replacement: null, maskLen: end - start,
        author: actor, createdAt: nowIso,
        nods: [{ by: actor, at: nowIso }],
      };
      d._ann[id] = ann;
      this._event(d, 'mask.nodded', actor, docId, { annotation: id, len: end - start });
      return { doc: this._docView(d, doc), annotation: this._publicAnnotation(d, docId, ann),
        outcome: 'waiting', applied: false };
    });
  }

  // 把【已经由两个不同审阅人点齐】的遮罩选区落盘：正文文字换成遮罩块、
  // 重叠批注封存、放行快照/母稿传播同步抹除。只在此事务内存中使用选区，不落盘原文。
  _applyConfirmedMasks(d, doc, confirmed /* [{start,end,nods}] */, actor) {
    const preMaskContent = doc.content;
    let content = preMaskContent;
    const sealed = [];
    const maskedRanges = [];
    const sorted = [...confirmed].sort((x, y) => y.start - x.start);
    for (const c of sorted) {
      const chars = codePoints(content);
      maskedRanges.push({ start: c.start, end: c.end });
      const block = maskBlock(c.end - c.start);
      const next = chars.slice(0, c.start).join('') + block + chars.slice(c.end).join('');
      const ops = contentOpcodes(content, next);
      // 点齐的两条遮罩提议删除：历史里不保留选区文字，只留“遮罩 N 字 / 谁点的头”
      for (const a of Object.values(d._ann || {}).filter(x =>
        x.docId === doc.id && x.kind === 'mask' && x.status === 'proposed' && x.start !== null &&
        x.start === c.start && x.end === c.end)) {
        delete d._ann[a.id];
      }
      this._sealAndRemap(d, doc, ops, c.start, c.start + cpLen(block), actor, sealed);
      content = next;
    }

    doc.content = content;
    doc.version += 1;
    doc.updatedAt = new Date().toISOString();
    this._scrubReleases(d, doc, preMaskContent, maskedRanges, actor, null);
    this._propagateMasks(d, doc, preMaskContent, maskedRanges, actor);
    return { doc: this._docView(d, doc), sealed };
  }

  // 遮罩块落进正文后：与块重叠/被吞掉的批注一律封存（备注/替换文清空），
  // 其余批注按 diff 重定位。确认遮罩与母稿同步遮罩共用这一套。
  _sealAndRemap(d, doc, ops, blockStart, blockEnd, actor, sealedOut) {
    for (const other of Object.values(d._ann || {}).filter(x => x.docId === doc.id)) {
      if (other.kind === 'mask') {
        // 点齐落盘的两条提议已由调用方删除；这里处理其余遮罩提议
        if (other.status !== 'proposed' || other.start === null) continue;
        const mm = mapRange(other.start, other.end, ops);
        const intersects = (mm.status === 'mapped' && mm.start < blockEnd && mm.end > blockStart);
        if (mm.status === 'orphaned' || intersects) {
          // 选区被本次遮罩块吞掉或压到：该点头作废，需对当前正文重新划
          other.start = null; other.end = null;
          other.status = 'void'; other.voidReason = 'mask-overlap';
          this._event(d, 'mask.voided', other.author, doc.id, { annotation: other.id, reason: 'mask-overlap' });
        } else {
          other.start = mm.start; other.end = mm.end; other.version = doc.version + 1;
        }
        continue;
      }
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
    const cbList = (d.callbacks && d.callbacks[doc.id]) || [];
    return {
      id: doc.id, title: doc.title, content: doc.content,
      version: doc.version, status: doc.status,
      updatedAt: doc.updatedAt, closedAt: doc.closedAt,
      masks: extractMasks(doc.content),
      parentId: doc.parentId || null,
      baseVersion: doc.baseVersion || null,
      paragraphs: paragraphBounds(doc.content).map(([start, end]) => ({ start, end })),
      releases: (doc.releases || []).map(r => this._releaseView(r)),
      recalls: (doc.recalls || []).map(o => this._recallView(o)),
      callbacks: cbList.length,
      callbackSummary: doc.parentId ? this._callbackSummary(cbList.map(c => this._callbackView(c))) : [],
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

// 渠道名：去掉两端空白，压缩内部连续空白，限长。渠道名只记账、不做账号体系。
function normalizeChannel(channel) {
  if (typeof channel !== 'string') return '';
  const c = channel.trim().replace(/\s+/g, ' ');
  return c.slice(0, 100);
}

module.exports = { Service, httpError };
