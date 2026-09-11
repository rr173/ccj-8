'use strict';
// 通用工具：文本 diff、批注位置跟随、遮罩块处理、密码哈希、签名会话

const crypto = require('crypto');

// ---------- 文本 diff（Myers，opcodes 供批注位置映射用） ----------
// 以 code point 为单位。opcode: [tag, i1, i2, j1, j2]
// tag ∈ equal | insert | delete | replace，区间均为左闭右开。
function codePoints(s) {
  return Array.from(s);
}

function diffOpcodes(a, b, eq) {
  const A = Array.isArray(a) ? a : codePoints(a);
  const B = Array.isArray(b) ? b : codePoints(b);
  const equals = eq || ((x, y) => x === y);
  const n = A.length, m = B.length;
  // Myers：V[k] = x。每轮 d 开始时保存 V 快照，回溯用 trace[d]。
  const V = new Map();
  const trace = [];
  let finalD = 0;
  outer:
  for (let d = 0; d <= n + m; d++) {
    trace.push(new Map(V));
    for (let k = -d; k <= d; k += 2) {
      const down = (k === -d || (k !== d && (V.get(k - 1) ?? -1) < (V.get(k + 1) ?? -1)));
      let x = down ? (V.get(k + 1) ?? -1) : (V.get(k - 1) ?? -1) + 1;
      if (x < 0) x = 0;
      let y = x - k;
      while (x < n && y < m && equals(A[x], B[y])) { x++; y++; }
      V.set(k, x);
      if (x >= n && y >= m) { finalD = d; break outer; }
    }
  }
  // 回溯蛇形路径
  const snakes = [];
  let x = n, y = m;
  for (let d = finalD; d > 0; d--) {
    const Vd = trace[d];
    const k = x - y;
    const down = (k === -d || (k !== d && (Vd.get(k - 1) ?? -1) < (Vd.get(k + 1) ?? -1)));
    const kPrev = down ? k + 1 : k - 1;
    const xPrev = Vd.get(kPrev);
    const yPrev = xPrev - kPrev;
    // 相等延伸段
    const ex = down ? xPrev : xPrev + 1;
    const ey = down ? yPrev + 1 : yPrev;
    if (x > ex || y > ey) snakes.push({ from: [ex, ey], to: [x, y], type: 'equal' });
    snakes.push({ from: [xPrev, yPrev], to: [ex, ey], type: down ? 'insert' : 'delete' });
    x = xPrev; y = yPrev;
  }
  if (x > 0) snakes.push({ from: [0, 0], to: [x, y], type: 'equal' });
  snakes.reverse();
  const raw = snakes.map(s => {
    if (s.type === 'equal') return ['equal', s.from[0], s.to[0], s.from[1], s.to[1]];
    if (s.type === 'insert') return ['insert', s.from[0], s.to[0], s.from[1], s.to[1]];
    return ['delete', s.from[0], s.to[0], s.from[1], s.to[1]];
  });
  // 合并相邻同类 op
  const ops = [];
  for (const op of raw) {
    const last = ops[ops.length - 1];
    if (last && last[0] === op[0] && last[2] === op[1] && last[4] === op[3]) {
      last[2] = op[2]; last[4] = op[4];
    } else ops.push([...op]);
  }
  // 相邻 delete + insert（位置相接，两种顺序）-> replace
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const cur = ops[i], nxt = ops[i + 1];
    if (nxt && cur[0] === 'delete' && nxt[0] === 'insert' && cur[2] === nxt[1]) {
      out.push(['replace', cur[1], cur[2], nxt[3], nxt[4]]);
      i++;
    } else if (nxt && cur[0] === 'insert' && nxt[0] === 'delete' && cur[1] === nxt[2]) {
      out.push(['replace', nxt[1], nxt[2], cur[3], cur[4]]);
      i++;
    } else out.push(cur);
  }
  return out;
}

// 把旧文本上的区间 [start,end)（code point 偏移）映射到新文本。
// 返回 {start,end,status}，status ∈ 'mapped' | 'orphaned'。
// 核心原则“宁丢不错位”：
//   - 区间内任何字符被删除/替换 -> orphaned，绝不猜位置；
//   - 端点可以落在 edit 块的边界上（插入发生在边界时，start 取最左、
//     end 取最右，即“插入紧跟在批注前面/后面”的自然语义）；
//   - 端点落在 replace/delete 块内部，或根本找不到 -> orphaned。
function mapRange(oldStart, oldEnd, ops) {
  const startCands = [], endCands = [];
  let deletedInside = 0;
  for (const [tag, i1, i2, j1, j2] of ops) {
    // start 候选
    if (tag === 'equal') {
      if (i1 <= oldStart && oldStart <= i2) startCands.push(j1 + (oldStart - i1));
      if (i1 <= oldEnd && oldEnd <= i2) endCands.push(j1 + (oldEnd - i1));
    } else if (tag === 'insert') {
      if (oldStart === i1) startCands.push(j1, j2);
      if (oldEnd === i1) endCands.push(j1, j2);
    } else { // delete / replace
      if (oldStart === i1) startCands.push(j1);
      if (oldStart === i2) startCands.push(j2);
      if (oldEnd === i1) endCands.push(j1);
      if (oldEnd === i2) endCands.push(j2);
      const os = Math.max(oldStart, i1);
      const oe = Math.min(oldEnd, i2);
      if (os < oe) deletedInside += (tag === 'delete') ? (oe - os) : (oe - os);
    }
  }
  if (!startCands.length || !endCands.length || deletedInside > 0) {
    return { start: null, end: null, status: 'orphaned' };
  }
  const newStart = Math.max(...startCands);
  const newEnd = Math.min(...endCands);
  return { start: newStart, end: Math.max(newEnd, newStart), status: 'mapped' };
}

// 宽松区间映射（遮罩传播专用）：与 mapRange 的“宁丢不错位”相反——
// 区间内被投放稿删/改过也要把对应的那一段框出来：端点落在删改块内部时
// 贴到该块的起/止边界，保证母稿确认遮罩后，投放稿里对应位置（哪怕改写过）
// 整体被遮住；同时只框对应这一处，不碰文中其他相同的字。
function mapRangeLoose(oldStart, oldEnd, ops) {
  const startCands = [], endCands = [];
  for (const [tag, i1, i2, j1, j2] of ops) {
    if (tag === 'equal') {
      if (i1 <= oldStart && oldStart <= i2) startCands.push(j1 + (oldStart - i1));
      if (i1 <= oldEnd && oldEnd <= i2) endCands.push(j1 + (oldEnd - i1));
    } else if (tag === 'insert') {
      if (oldStart === i1) startCands.push(j1, j2);
      if (oldEnd === i1) endCands.push(j1, j2);
    } else { // delete / replace：端点落边界按边界算，落内部则贴到该块的起/止
      if (oldStart === i1) startCands.push(j1);
      else if (oldStart === i2) startCands.push(j2);
      else if (i1 < oldStart && oldStart < i2) startCands.push(j1);
      if (oldEnd === i1) endCands.push(j1);
      else if (oldEnd === i2) endCands.push(j2);
      else if (i1 < oldEnd && oldEnd < i2) endCands.push(j2);
    }
  }
  if (!startCands.length || !endCands.length) return null;
  const start = Math.max(...startCands);
  const end = Math.min(...endCands);
  return { start, end: Math.max(end, start) };
}

// ---------- 文档遮罩块 ----------
// 内容以 code point 文本保存；遮罩块用内联占位符：
//   '⟦' + n 个 '█' + '⟧'，n = 被遮字符数。
// 哨兵字符不允许出现在作者正文中（编辑接口会拒绝）。
const MARK = '⟦';
const MARK_END = '⟧';
function maskBlock(len) {
  return MARK + '█'.repeat(Math.max(1, len)) + MARK_END;
}
function extractMasks(text) {
  const chars = codePoints(text);
  const blocks = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === MARK) {
      let j = i + 1, count = 0;
      while (j < chars.length && chars[j] === '█') { count++; j++; }
      if (j < chars.length && chars[j] === MARK_END) {
        blocks.push({ start: i, end: j + 1, len: count });
        i = j + 1; continue;
      }
    }
    i++;
  }
  return blocks;
}

// 把文本切成 token 数组：遮罩块整体作为 1 个原子 token（kind:'mask'），
// 其余每个 code point 一个 token（kind:'ch'）。
// 返回 { tokens, masks }；mask token 的 text 形如 '⟦███⟧'。
function tokenize(text) {
  const chars = codePoints(text);
  const tokens = [];
  const masks = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === MARK) {
      let j = i + 1, count = 0;
      while (j < chars.length && chars[j] === '█') { count++; j++; }
      if (j < chars.length && chars[j] === MARK_END) {
        j++;
        const block = chars.slice(i, j).join('');
        masks.push({ len: count });
        tokens.push({ kind: 'mask', text: block, len: count });
        i = j; continue;
      }
    }
    tokens.push({ kind: 'ch', text: chars[i] });
    i++;
  }
  return { tokens, masks };
}

// 对“含遮罩块的正文”做 diff：遮罩块作为原子 token（不可拆分匹配），
// 其余每个 code point 一个 token。返回的 opcodes 坐标统一换算成
// code point 偏移（遮罩块按其占位符全长计），供批注映射直接使用。
function contentOpcodes(oldText, newText) {
  const ta = tokenize(oldText), tb = tokenize(newText);
  const A = ta.tokens, B = tb.tokens;
  const offA = [0], offB = [0];
  for (const t of A) offA.push(offA[offA.length - 1] + (t.kind === 'mask' ? cpLen(t.text) : 1));
  for (const t of B) offB.push(offB[offB.length - 1] + (t.kind === 'mask' ? cpLen(t.text) : 1));
  const tokOps = diffOpcodes(A, B, (x, y) => x.kind === y.kind && x.text === y.text);
  return tokOps.map(([tag, i1, i2, j1, j2]) =>
    [tag, offA[i1], offA[i2], offB[j1], offB[j2]]);
}

// 作者改原文时校验：
//  1) 正文里不得出现孤立哨兵字符（⟦/⟧ 只能作为合法遮罩块出现）；
//  2) 已确认遮罩块是原子的、不可新建/删除/改动/移位覆盖对象。
//     判据：在 token diff 中，双方所有遮罩块都必须落在 equal 段内
//     （把遮罩移到另一段文字会导致旧位置的块落入 replace/delete，拒绝）。
// 返回错误字符串或 null。
function validateAuthorEdit(oldText, newText) {
  if (typeof newText !== 'string') return '内容必须是文本';
  const totalMarks = (newText.match(/⟦|⟧/g) || []).length;
  const newMasks = extractMasks(newText);
  if (totalMarks !== newMasks.length * 2) return '正文中不允许使用 ⟦ 或 ⟧ 字符';
  const oldMasks = extractMasks(oldText);
  if (newMasks.length !== oldMasks.length) return '已确认的遮罩块不可删除或新增';
  // 数量相同时按顺序一一配对：块长相同且在 token diff 中完全对应到同一个 equal 段。
  // 逐块比较其 token 序号是否落在同一条 equal op 内且相对顺序一致，
  // 从而拒绝“块被搬到另一段文字前后”的编辑。
  const A = tokenize(oldText).tokens, B = tokenize(newText).tokens;
  const tokOps = diffOpcodes(A, B, (x, y) => x.kind === y.kind && x.text === y.text);
  let oi = 0;
  for (const [tag, i1, i2, j1, j2] of tokOps) {
    if (tag !== 'equal') {
      for (let i = i1; i < i2; i++) if (A[i].kind === 'mask') return '已确认的遮罩块不可移动或覆盖到其他文字';
      for (let j = j1; j < j2; j++) if (B[j].kind === 'mask') return '已确认的遮罩块不可移动或覆盖到其他文字';
      continue;
    }
    // equal 段内的 mask token 必须按顺序、等长逐个对应
    for (let i = i1, j = j1; i < i2; i++, j++) {
      if (A[i].kind === 'mask' || B[j].kind === 'mask') {
        if (A[i].kind !== 'mask' || B[j].kind !== 'mask' || A[i].len !== B[j].len) {
          return '已确认的遮罩块不可移动或覆盖到其他文字';
        }
        oi++;
      }
    }
  }
  if (oi !== oldMasks.length) return '已确认的遮罩块不可移动或覆盖到其他文字';
  return null;
}

function cpLen(s) { return codePoints(s).length; }

// ---------- 段（按段放行用） ----------
// 段以换行分隔；返回每段在 code-point 坐标上的 [start, end)（不含换行符本身）。
// 遮罩块原子计入其占位长度，与正文坐标体系一致。
function paragraphBounds(text) {
  const chars = codePoints(text);
  const bounds = [];
  let start = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i === chars.length || chars[i] === '\n') {
      bounds.push([start, i]);
      start = i + 1;
    }
  }
  return bounds;
}

// ---------- 母稿 → 投放稿：三方合并 ----------
// base   = 投放稿记录的母稿正文（上次同步时）；master = 母稿当前正文；child = 投放稿当前正文。
// 先按“段”（换行分隔）对齐：
//   - 母稿改了、投放稿没改的段 → 跟着母稿变；
//   - 投放稿自己改过、母稿没动的段 → 保留投放稿的；
//   - 母稿删了、投放稿没改 → 删；母稿删了、投放稿改过 → 保留投放稿的；
//   - 双方在同一段边界各自插入 → 都保留（完全相同的插入只留一份）；
//   - 双方都改了同一段 → 段内再按字三方合并（mergeTokens）：投放稿没改过的字
//     跟着母稿变，改过的字保留（没有换行的文案也能只跟句首、保住句尾）。
// 遮罩块不走合并：母稿确认遮罩由 _propagateMasks 按位置强制同步（改过的段也逃不掉）。
function mergeParagraphs(base, master, child) {
  if (child === base) return master;   // 投放稿没动过 → 整份跟母稿
  if (master === base) return child;   // 母稿没变 → 不动
  const B = base.split('\n'), M = master.split('\n'), C = child.split('\n');
  const eq = (x, y) => x === y;
  const mSide = paragraphMap(diffOpcodes(B, M, eq), M);
  const cSide = paragraphMap(diffOpcodes(B, C, eq), C);
  return walkMerge(B, mSide, cSide, eq,
    (basePara, mPara, cPara) => mergeTokens(basePara, mPara, cPara)).join('\n');
}

// 段内按字（遮罩块为原子 token）三方合并：同一处两边都改 → 投放稿优先。
function mergeTokens(base, master, child) {
  if (child === base) return master;
  if (master === base) return child;
  const B = tokenize(base).tokens, M = tokenize(master).tokens, C = tokenize(child).tokens;
  const eq = (x, y) => x.kind === y.kind && x.text === y.text;
  const mSide = paragraphMap(diffOpcodes(B, M, eq), M);
  const cSide = paragraphMap(diffOpcodes(B, C, eq), C);
  return walkMerge(B, mSide, cSide, eq, (b, m, c) => c).map(t => t.text).join('');
}

// 三方合并主循环：B 为基准序列，mSide/cSide 是两侧 paragraphMap 的结果。
// 双方都改了同一项时由 bothChanged(baseItem, masterItem, childItem) 决定结果。
function walkMerge(B, mSide, cSide, eq, bothChanged) {
  const out = [];
  for (let i = 0; i <= B.length; i++) {
    // 边界 i 上双方各自插入的项：都保留，完全相同的去重
    const ci = cSide.ins.get(i) || [];
    const pool = ci.slice();
    out.push(...ci);
    for (const t of (mSide.ins.get(i) || [])) {
      const k = pool.findIndex(x => eq(x, t));
      if (k >= 0) pool.splice(k, 1);
      else out.push(t);
    }
    if (i === B.length) break;
    const m = mSide.map[i], c = cSide.map[i];
    if (c.type === 'deleted') continue;              // 投放稿自己删了
    if (m.type === 'deleted') {                      // 母稿删了
      if (c.type === 'changed') out.push(c.text);    // 投放稿改过 → 保留
      continue;
    }
    if (c.type === 'same') { out.push(m.text); continue; }  // 没改过跟母稿
    if (m.type === 'same') { out.push(c.text); continue; }  // 改过保留本地
    out.push(bothChanged(B[i], m.text, c.text));            // 两边都改了同一项
  }
  return out;
}

// 把 base→next 的段落 diff 汇总成：map[i] = base 第 i 段的去向，ins = 各段边界上新增的段
function paragraphMap(ops, next) {
  const map = [], ins = new Map();
  const addIns = (boundary, texts) => {
    if (texts.length) ins.set(boundary, (ins.get(boundary) || []).concat(texts));
  };
  for (const [tag, i1, i2, j1, j2] of ops) {
    if (tag === 'equal') {
      for (let k = 0; k < i2 - i1; k++) map[i1 + k] = { type: 'same', text: next[j1 + k] };
    } else if (tag === 'delete') {
      for (let i = i1; i < i2; i++) map[i] = { type: 'deleted' };
    } else if (tag === 'insert') {
      addIns(i1, next.slice(j1, j2));
    } else { // replace：对齐配对算“改”，多出来的按删/插处理
      const paired = Math.min(i2 - i1, j2 - j1);
      for (let k = 0; k < paired; k++) map[i1 + k] = { type: 'changed', text: next[j1 + k] };
      for (let i = i1 + paired; i < i2; i++) map[i] = { type: 'deleted' };
      addIns(i1 + paired, next.slice(j1 + paired, j2));
    }
  }
  return { map, ins };
}

// ---------- 密码哈希 & 签名 ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const idx = stored.indexOf(':');
  const salt = stored.slice(0, idx);
  const hashBuf = Buffer.from(stored.slice(idx + 1), 'hex');
  const calc = crypto.scryptSync(password, salt, 32);
  return hashBuf.length === calc.length && crypto.timingSafeEqual(hashBuf, calc);
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function sign(data, secret) {
  const body = b64url(JSON.stringify(data));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}
function unsign(token, secret) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  const expect = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  if (sig.length !== expect.length) return null;
  let a, b;
  try { a = Buffer.from(sig); b = Buffer.from(expect); } catch { return null; }
  if (!crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch { return null; }
}
function randomToken() { return crypto.randomBytes(24).toString('hex'); }

module.exports = {
  codePoints, diffOpcodes, mapRange, mapRangeLoose, contentOpcodes,
  MARK, MARK_END, maskBlock, extractMasks, tokenize, validateAuthorEdit, cpLen,
  mergeParagraphs, mergeTokens, paragraphBounds,
  hashPassword, verifyPassword, sign, unsign, randomToken,
};
