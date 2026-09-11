'use strict';
// 端到端冒烟测试（不经网络，直接跑业务层）
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { JsonStore } = require('../src/store');
const { Service } = require('../src/domain');
const util = require('../src/util');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓', name); passed++; }
// 子串的 code-point 位置（批注/遮罩接口用 code-point 偏移）
function cpIndexOf(s, sub) {
  const i = s.indexOf(sub);
  return i < 0 ? i : Array.from(s.slice(0, i)).length;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const store = new JsonStore(path.join(tmp, 'data.json'));
  const svc = new Service(store);
  await svc.initUsers('apw', 'rpw');

  console.log('1) 创建文档与批注');
  const doc = await svc.createDoc('测试文案', '尊敬的客户，我们的密钥是ABCDEF，请妥善保管。', 'author');
  const full = await svc.getDoc(doc.id);
  //           01234567890123456789012345678 9 01234567
  // “ABCDEF” 位于
  const keyStart = Array.from(full.content).indexOf('A');
  const keyEnd = keyStart + 6;
  const c1 = await svc.addAnnotation({ docId: doc.id, kind: 'comment', start: 0, end: 4, note: '称呼太生硬' }, 'reviewer', 1);
  const s1 = await svc.addAnnotation({ docId: doc.id, kind: 'suggest', start: 9, end: 11, note: '措辞', replacement: '本公司的' }, 'reviewer', 1);
  const m1 = await svc.addAnnotation({ docId: doc.id, kind: 'mask', start: keyStart, end: keyEnd, note: '' }, 'reviewer', 1);
  ok('三条批注创建成功', c1.id && s1.id && m1.id);

  console.log('2) 打回批注：原文恢复/不变');
  const contentBefore = (await svc.getDoc(doc.id)).content;
  await svc.resolveAnnotation(doc.id, c1.id, 'reject', 'author', 1);
  ok('打回后原文一字不变', (await svc.getDoc(doc.id)).content === contentBefore);
  ok('打回状态', (await svc.annotations(doc.id)).find(a => a.id === c1.id).status === 'rejected');

  console.log('3) 接受修改建议：原文替换，其他批注跟随');
  const r3 = await svc.resolveAnnotation(doc.id, s1.id, 'accept', 'author', 1);
  ok('建议文字进入原文', r3.doc.content.includes('本公司的'));
  const anns3 = await svc.annotations(doc.id);
  const m1After = anns3.find(a => a.id === m1.id);
  ok('遮罩提议跟随到新位置', m1After.start === Array.from(r3.doc.content).indexOf('A'));
  ok('跟随位置覆盖的仍是 ABCDEF', anns3.find(a => a.id === m1.id).covered === 'ABCDEF');

  console.log('4) 作者改原文：批注跟随 / 失位不批错行');
  const doc4 = await svc.getDoc(doc.id);
  const v4 = doc4.version;
  // 在开头插入
  let edited = '【2026版】' + doc4.content;
  const r4 = await svc.editContent(doc.id, edited, 'author', v4);
  let anns4 = await svc.annotations(doc.id);
  const m1b = anns4.find(a => a.id === m1.id);
  ok('插入前缀后位置平移', m1b.start === Array.from(r4.content).indexOf('A') && m1b.covered === 'ABCDEF');
  // 删掉批注覆盖区的一个字符（B）→ 遮罩提议失位
  const pos = Array.from(r4.content).indexOf('B');
  const chars = Array.from(r4.content);
  const deleted = chars.slice(0, pos).join('') + chars.slice(pos + 1).join('');
  const r4b = await svc.editContent(doc.id, deleted, 'author', r4.version);
  anns4 = await svc.annotations(doc.id);
  const m1c = anns4.find(a => a.id === m1.id);
  ok('覆盖区被删 → 失去位置（不批错行）', m1c.status === 'orphaned' && m1c.start === null);
  ok('原文确实少了 B', !r4b.content.includes('B'));

  console.log('5) 审阅人重新定位失位遮罩');
  const aPos = Array.from(r4b.content).indexOf('A');
  await svc.repositionAnnotation(doc.id, m1.id, aPos, aPos + 5, 'reviewer', r4b.version);
  ok('重新定位成功', (await svc.annotations(doc.id)).find(a => a.id === m1.id).covered === 'ACDEF');

  console.log('6) 遮罩预览（不抹除、不落内容）');
  const prev = await svc.previewMasks(doc.id, null, 'reviewer');
  ok('预览里密钥被 █ 替代', !prev.preview.includes('ACDEF') && prev.preview.includes('█████'));
  ok('预览不改变正文', (await svc.getDoc(doc.id)).content.includes('ACDEF'));

  console.log('7) 加一条与遮罩重叠的批注，确认后应封存');
  const doc7 = await svc.getDoc(doc.id);
  // 第 5 步已把遮罩重新定位到 ACDEF（5 字），在其开头 3 字上划批注
  const m1pos = (await svc.annotations(doc.id)).find(a => a.id === m1.id);
  const overlap = await svc.addAnnotation(
    { docId: doc.id, kind: 'comment', start: m1pos.start, end: m1pos.start + 3, note: '机密！记得删掉这段里的备注 SECRETNOTE' },
    'reviewer', doc7.version);
  const conf = await svc.confirmMasks(doc.id, null, 'reviewer', doc7.version);
  const after = await svc.getDoc(doc.id);
  ok('确认后正文无被遮字符', !after.content.includes('A') && !after.content.includes('CDEF'));
  ok('正文里只剩遮罩块占位', util.extractMasks(after.content).length === 1);
  const sealedAnn = (await svc.annotations(doc.id)).find(a => a.id === overlap.id);
  ok('重叠批注被封存', sealedAnn.status === 'sealed' && sealedAnn.note === null && sealedAnn.covered == null && sealedAnn.sealed === true);
  ok('封存批注列表引用里无备注文字', JSON.stringify(await svc.annotations(doc.id)).indexOf('SECRETNOTE') < 0);
  ok('封存批注 id 有返回', conf.sealed.includes(overlap.id));

  console.log('8) 历史里看不到被遮的字');
  const events = await svc.events(doc.id);
  const dump = JSON.stringify(events);
  ok('历史无密钥字符', !dump.includes('ABCDEF') && !dump.includes('ACDEF') && !dump.includes('SECRETNOTE'));
  const maskEv = events.find(e => e.type === 'mask.confirmed');
  ok('历史只记录遮罩字数', maskEv.detail.len === 5);

  console.log('9) 对外稿：无系统标记、无原文');
  const ext = await svc.external(doc.id);
  ok('对外稿无 ⟦⟧', !ext.content.includes('⟦') && !ext.content.includes('⟧'));
  ok('对外稿无密钥', !ext.content.includes('ACDEF'));
  ok('对外稿有 █', ext.content.includes('█████'));

  console.log('10) 不可逆性：落盘文件里也找不到');
  const raw = fs.readFileSync(path.join(tmp, 'data.json'), 'utf8');
  ok('数据文件无被遮字符', !raw.includes('ABCDEF') && !raw.includes('ACDEF') && !raw.includes('SECRETNOTE'));

  console.log('11) 遮罩块受保护');
  const doc11 = await svc.getDoc(doc.id);
  const err1 = await svc.editContent(doc.id, doc11.content.replace(util.MARK, ''), 'author', doc11.version)
    .then(() => null, e => e.message);
  ok('删除遮罩块被拒绝', typeof err1 === 'string');
  const err2 = await svc.editContent(doc.id, '正文里偷塞⟦字符', 'author', doc11.version)
    .then(() => null, e => e.message);
  ok('哨兵字符被拒绝', typeof err2 === 'string');
  // 真正的“移动”：块被搬到另一段文字后面（与原文上下文错配）
  const beforeBlock = doc11.content.slice(0, util.extractMasks(doc11.content)[0].start);
  const afterBlock = doc11.content.slice(util.extractMasks(doc11.content)[0].end);
  const blockText = util.maskBlock(util.extractMasks(doc11.content)[0].len);
  const moved = beforeBlock + afterBlock + blockText; // 块从中间移到末尾
  const err3 = await svc.editContent(doc.id, moved, 'author', doc11.version)
    .then(() => null, e => e.message);
  ok('移动遮罩块被拒绝', typeof err3 === 'string');
  // 前缀插入合法（块相对原上下文没有移动）
  const ok3 = await svc.editContent(doc.id, '前缀' + doc11.content, 'author', doc11.version)
    .then(() => true, () => false);
  ok('块前插入新文字允许', ok3 === true);

  console.log('12) 版本冲突与冻结');
  const err4 = await svc.editContent(doc.id, doc11.content + 'x', 'author', doc11.version - 1)
    .then(() => null, e => e);
  ok('旧版本保存被拒', err4 && err4.status === 409);
  await svc.closeDoc(doc.id, 'reviewer');
  const err5 = await svc.addAnnotation({ docId: doc.id, kind: 'comment', start: 0, end: 1, note: 'x' }, 'reviewer', null)
    .then(() => null, e => e);
  ok('冻结后不能批注', err5 && err5.status === 409);

  console.log('13) 派生：与母稿同一份字，已确认遮罩一并带过去');
  const mContent = '第一段：公开文字甲，内部代号OMEGA七。\n第二段：报价九千万元整。\n第三段：联系方式保密。';
  const master = await svc.createDoc('母稿', mContent, 'author');
  const oPos = cpIndexOf(mContent, 'OMEGA');
  await svc.addAnnotation({ docId: master.id, kind: 'mask', start: oPos, end: oPos + 5, note: '' }, 'reviewer', 1);
  await svc.confirmMasks(master.id, null, 'reviewer', 1);
  const masterDoc = await svc.getDoc(master.id);
  ok('母稿遮罩已确认', masterDoc.content.includes('⟦█████⟧') && !masterDoc.content.includes('OMEGA'));
  const k1 = await svc.deriveDoc(master.id, '', 'author');
  const k2 = await svc.deriveDoc(master.id, '渠道B稿', 'author');
  ok('派生稿与母稿同一份字', k1.content === masterDoc.content && k2.content === masterDoc.content);
  ok('已确认遮罩在派生稿里就是遮着的', k1.content.includes('⟦█████⟧'));
  ok('派生稿不带母稿批注', (await svc.annotations(k1.id)).length === 0);
  ok('列表带派生关系', (await svc.listDocs()).find(d => d.id === master.id).derived === 2);

  console.log('14) 母稿改未遮的字：没改过的跟着变，改过的字保留');
  // k1 自己改第一段和第二段（第二段保留“九千万元”，追加“（含税）”）
  const k1Doc0 = await svc.getDoc(k1.id);
  const k1Local = k1Doc0.content.replace('公开文字甲', '公开文字甲改').replace('报价九千万元整', '报价九千万元整（含税）');
  await svc.editContent(k1.id, k1Local, 'author', 1);
  // 母稿改第一段和第三段
  const mEdit = masterDoc.content.replace('公开文字甲', '公开文字乙').replace('联系方式保密', '联系方式见官网');
  await svc.editContent(master.id, mEdit, 'author', 2);
  let k1After = await svc.getDoc(k1.id);
  let k2After = await svc.getDoc(k2.id);
  ok('k1 改过的字保留、没改过的字跟着母稿变（段内合并）', k1After.content.includes('公开文字乙改') && !k1After.content.includes('公开文字甲'));
  ok('k1 没改过的段跟着母稿变', k1After.content.includes('联系方式见官网'));
  ok('k1 本地第二段保持', k1After.content.includes('报价九千万元整（含税）'));
  ok('k2 没改过 → 完全跟着母稿', k2After.content.includes('公开文字乙') && k2After.content.includes('联系方式见官网'));

  console.log('15) 母稿确认新遮罩：各投放稿跟着遮掉，改过的段也不留原文');
  // k1 上先有：一条盖住“九千万元”的批注（会被封存）、一条盖第三段的批注（会跟着移位）
  const k1Doc1 = await svc.getDoc(k1.id);
  const p9 = cpIndexOf(k1Doc1.content, '九千万元');
  const sealAnn = await svc.addAnnotation({ docId: k1.id, kind: 'comment', start: p9, end: p9 + 4, note: 'SECRETNOTE2' }, 'reviewer', k1Doc1.version);
  const p3 = cpIndexOf(k1Doc1.content, '联系方式见官网');
  const moveAnn = await svc.addAnnotation({ docId: k1.id, kind: 'comment', start: p3, end: p3 + 7, note: '第三段批注' }, 'reviewer', k1Doc1.version);
  // 母稿确认遮掉“九千万元”
  const mDoc2 = await svc.getDoc(master.id);
  const m9 = cpIndexOf(mDoc2.content, '九千万元');
  await svc.addAnnotation({ docId: master.id, kind: 'mask', start: m9, end: m9 + 4, note: '' }, 'reviewer', mDoc2.version);
  await svc.confirmMasks(master.id, null, 'reviewer', mDoc2.version);
  k1After = await svc.getDoc(k1.id);
  k2After = await svc.getDoc(k2.id);
  ok('母稿原文已抹除', !(await svc.getDoc(master.id)).content.includes('九千万元'));
  ok('k1 改过的段也跟着遮掉', !k1After.content.includes('九千万元') && k1After.content.includes('⟦████⟧'));
  ok('k1 本地改动（含税）仍在', k1After.content.includes('（含税）'));
  ok('k2 跟着遮掉', !k2After.content.includes('九千万元') && k2After.content.includes('⟦████⟧'));
  const k1Anns = await svc.annotations(k1.id);
  const sealed2 = k1Anns.find(a => a.id === sealAnn.id);
  ok('与同步遮罩重叠的批注被封存', sealed2.status === 'sealed' && sealed2.note === null);
  ok('封存后批注列表无备注原文', !JSON.stringify(k1Anns).includes('SECRETNOTE2'));
  const moved2 = k1Anns.find(a => a.id === moveAnn.id);
  ok('同步遮罩时未确认批注跟着位置走', moved2.status === 'proposed' && moved2.covered === '联系方式见官网');

  console.log('16) 投放稿自己的批注/遮罩只动这一份；两份投放稿互不覆盖');
  // k1 自己遮“乙改”
  const k1Doc2 = await svc.getDoc(k1.id);
  const pj = cpIndexOf(k1Doc2.content, '乙改');
  await svc.addAnnotation({ docId: k1.id, kind: 'mask', start: pj, end: pj + 2, note: '' }, 'reviewer', k1Doc2.version);
  const mBefore = (await svc.getDoc(master.id)).content;
  const k2Before = (await svc.getDoc(k2.id)).content;
  await svc.confirmMasks(k1.id, null, 'reviewer', k1Doc2.version);
  ok('k1 自己的遮罩生效', !(await svc.getDoc(k1.id)).content.includes('乙改'));
  ok('派生稿遮罩不写回母稿', (await svc.getDoc(master.id)).content === mBefore);
  ok('另一份投放稿不受影响', (await svc.getDoc(k2.id)).content === k2Before);
  // 打回只恢复这一份
  const k1Doc3 = await svc.getDoc(k1.id);
  const sg = await svc.addAnnotation({ docId: k1.id, kind: 'suggest', start: 0, end: 3, note: '', replacement: '第某段' }, 'reviewer', k1Doc3.version);
  await svc.resolveAnnotation(k1.id, sg.id, 'reject', 'author', k1Doc3.version);
  ok('k1 打回后本稿原文不变', (await svc.getDoc(k1.id)).content === k1Doc3.content);
  ok('打回不碰母稿', (await svc.getDoc(master.id)).content === mBefore);
  // 两份投放稿各自改第三段，互不覆盖
  await svc.editContent(k1.id, (await svc.getDoc(k1.id)).content.replace('联系方式见官网', '联系方式见官网首页'), 'author', (await svc.getDoc(k1.id)).version);
  await svc.editContent(k2.id, (await svc.getDoc(k2.id)).content.replace('联系方式见官网', '联系方式见官网底部'), 'author', (await svc.getDoc(k2.id)).version);
  ok('k1 的改法保留', (await svc.getDoc(k1.id)).content.includes('联系方式见官网首页'));
  ok('k2 的改法保留', (await svc.getDoc(k2.id)).content.includes('联系方式见官网底部'));
  // 改某一份时，这一份上未确认的批注跟着位置走
  const k2Doc = await svc.getDoc(k2.id);
  const pw = cpIndexOf(k2Doc.content, '公开文字乙');
  const followAnn = await svc.addAnnotation({ docId: k2.id, kind: 'comment', start: pw, end: pw + 5, note: '跟随我' }, 'reviewer', k2Doc.version);
  await svc.editContent(k2.id, '【置顶】' + k2Doc.content, 'author', k2Doc.version);
  const followed = (await svc.annotations(k2.id)).find(a => a.id === followAnn.id);
  ok('改某一份时该份批注跟着位置走', followed.status === 'proposed' && followed.covered === '公开文字乙');
  // 对外看某一份只能看到那一份遮完后的字（先逐段放行；没放行的段外面没有）
  const k1View = await svc.getDoc(k1.id);
  for (let p = 0; p < k1View.paragraphs.length; p++) {
    await svc.releaseParagraph(k1.id, p, 'author', (await svc.getDoc(k1.id)).version);
  }
  const k2View = await svc.getDoc(k2.id);
  await svc.releaseParagraph(k2.id, 0, 'author', k2View.version); // k2 只放第一段
  const ext1 = await svc.external(k1.id);
  ok('k1 对外稿无 k1 已遮文字', !ext1.content.includes('乙改') && !ext1.content.includes('九千万元') && ext1.content.includes('██'));
  const ext2 = await svc.external(k2.id);
  ok('k2 对外稿是 k2 自己的字', ext2.content.includes('公开文字乙') && !ext2.content.includes('乙改'));
  ok('k2 只放行第一段：后面的段外面读不到', !ext2.content.includes('联系方式'));

  console.log('17) 已冻结的投放稿：文字不再同步，遮罩仍强制同步');
  await svc.closeDoc(k2.id, 'reviewer');
  const mDoc3 = await svc.getDoc(master.id);
  await svc.editContent(master.id, mDoc3.content.replace('公开文字乙', '公开文字丙'), 'author', mDoc3.version);
  ok('冻结的投放稿不跟文字同步', (await svc.getDoc(k2.id)).content.includes('公开文字乙'));
  ok('k1 自己改过的段也不被这次母稿改动盖掉', (await svc.getDoc(k1.id)).content.includes('公开文字⟦██⟧'));
  // 母稿确认遮“见官网” → k2 冻结也必须遮掉
  const mDoc4 = await svc.getDoc(master.id);
  const pg = cpIndexOf(mDoc4.content, '见官网');
  await svc.addAnnotation({ docId: master.id, kind: 'mask', start: pg, end: pg + 3, note: '' }, 'reviewer', mDoc4.version);
  await svc.confirmMasks(master.id, null, 'reviewer', mDoc4.version);
  const k2Frozen = await svc.getDoc(k2.id);
  ok('冻结的投放稿也跟着遮掉', !k2Frozen.content.includes('见官网') && k2Frozen.content.includes('⟦███⟧'));
  const k1After2 = await svc.getDoc(k1.id);
  ok('k1 本地段里对应的那处也被遮掉', !k1After2.content.includes('见官网') && k1After2.content.includes('首页'));

  console.log('18) 级联派生 + 落盘无任何被遮原文');
  const g = await svc.deriveDoc(k1.id, '孙稿', 'author');
  const mDoc5 = await svc.getDoc(master.id);
  const pl = cpIndexOf(mDoc5.content, '联系方式');
  await svc.addAnnotation({ docId: master.id, kind: 'mask', start: pl, end: pl + 4, note: '' }, 'reviewer', mDoc5.version);
  await svc.confirmMasks(master.id, null, 'reviewer', mDoc5.version);
  const gDoc = await svc.getDoc(g.id);
  ok('孙稿级联遮掉同一段', !gDoc.content.includes('联系方式') && gDoc.content.includes('⟦████⟧'));
  ok('孙稿基准版本跟着 k1 走', gDoc.baseVersion === (await svc.getDoc(k1.id)).version);
  const raw2 = fs.readFileSync(path.join(tmp, 'data.json'), 'utf8');
  for (const secret of ['OMEGA', '九千万元', '乙改', '见官网', '联系方式', 'SECRETNOTE2']) {
    ok(`落盘文件无「${secret}」`, !raw2.includes(secret));
  }
  const allEvents = await svc.events(null, 5000);
  ok('全部历史无被遮原文', !['OMEGA', '九千万元', '乙改', '见官网', 'SECRETNOTE2'].some(s => JSON.stringify(allEvents).includes(s)));

  console.log('19) 无换行文案：投放稿改句尾，母稿改句首 → 句首要跟着变');
  const oneLine = '开头一句话，中间一句话，结尾一句话。';
  const mA = await svc.createDoc('单行母稿', oneLine, 'author');
  const kA = await svc.deriveDoc(mA.id, '单行投放稿', 'author');
  // 投放稿只改句尾
  await svc.editContent(kA.id, oneLine.replace('结尾一句话', '结尾一句话改'), 'author', 1);
  // 母稿再改句首
  await svc.editContent(mA.id, oneLine.replace('开头一句话', '开头改'), 'author', 1);
  const kAAfter = await svc.getDoc(kA.id);
  ok('没改过的句首跟着母稿变', kAAfter.content.includes('开头改'));
  ok('投放稿自己改的句尾保留', kAAfter.content.includes('结尾一句话改'));
  ok('中间没动过的地方不变', kAAfter.content.includes('中间一句话'));
  ok('整篇合并结果精确', kAAfter.content === '开头改，中间一句话，结尾一句话改。');

  console.log('20) 投放稿改过要遮的那串字：母稿确认遮罩后对外读不到');
  const mB = await svc.createDoc('母稿B', '兹有内部代号DELTA9，请勿外传。', 'author');
  const kB = await svc.deriveDoc(mB.id, '投放稿B', 'author');
  // 投放稿把后来要遮的代号改写过
  await svc.editContent(kB.id, '兹有内部代号德塔九号，请勿外传。', 'author', 1);
  const mBDoc = await svc.getDoc(mB.id);
  const dPos = cpIndexOf(mBDoc.content, 'DELTA9');
  await svc.addAnnotation({ docId: mB.id, kind: 'mask', start: dPos, end: dPos + 6, note: '' }, 'reviewer', mBDoc.version);
  await svc.confirmMasks(mB.id, null, 'reviewer', mBDoc.version);
  const kBAfter = await svc.getDoc(kB.id);
  ok('投放稿改写过的代号也被遮掉', !kBAfter.content.includes('德塔九号') && kBAfter.content.includes('⟦████⟧'));
  ok('遮罩只盖代号、上下文不动', kBAfter.content === '兹有内部代号⟦████⟧，请勿外传。');
  await svc.releaseParagraph(kB.id, 0, 'author', (await svc.getDoc(kB.id)).version);
  const kBExt = await svc.external(kB.id);
  ok('对外读不到改过的代号', !kBExt.content.includes('德塔九号') && kBExt.content.includes('████'));
  const rawB = fs.readFileSync(path.join(tmp, 'data.json'), 'utf8');
  ok('落盘文件无改写过的代号', !rawB.includes('德塔九号') && !rawB.includes('DELTA9'));

  console.log('21) 母稿只遮开头一处相同的字：投放稿结尾那处不被连坐');
  const mC = await svc.createDoc('母稿C', '代号ALPHA开头，中间无关，结尾又是ALPHA。', 'author');
  const kC = await svc.deriveDoc(mC.id, '投放稿C', 'author');
  const mCDoc = await svc.getDoc(mC.id);
  const firstAlpha = cpIndexOf(mCDoc.content, 'ALPHA'); // 只遮第一处
  await svc.addAnnotation({ docId: mC.id, kind: 'mask', start: firstAlpha, end: firstAlpha + 5, note: '' }, 'reviewer', mCDoc.version);
  await svc.confirmMasks(mC.id, null, 'reviewer', mCDoc.version);
  const kCAfter = await svc.getDoc(kC.id);
  ok('对应的那一处被遮掉', kCAfter.content.includes('代号⟦█████⟧开头'));
  ok('结尾相同的字不被连坐', kCAfter.content.includes('结尾又是ALPHA。'));
  await svc.releaseParagraph(kC.id, 0, 'author', (await svc.getDoc(kC.id)).version);
  const kCExt = await svc.external(kC.id);
  ok('对外稿也只遮那一处', kCExt.content.includes('代号█████开头') && kCExt.content.includes('结尾又是ALPHA。'));

  console.log('22) 按段放行：不亮则空、按段独立、只看放行时遮后字、后续遮罩追加、不可收回');
  const pText = '首段：公开内容甲。\n二段：代号NOVA八，先放行。\n三段：内部底价九千万。';
  const pm = await svc.createDoc('放行母稿', pText, 'author');
  const pa = await svc.deriveDoc(pm.id, '投放稿甲', 'author');
  const pb = await svc.deriveDoc(pm.id, '投放稿乙', 'author');

  // (a) 没放行任何段：外面整份是空的——连段数、篇幅、换行都没有
  const emptyA = await svc.external(pa.id);
  ok('未放行：对外稿为空字符串', emptyA.content === '' && emptyA.released === 0);
  const emptyB = await svc.external(pb.id);
  ok('另一份同样为空', emptyB.content === '');
  ok('未放行段原文不在对外响应里', JSON.stringify(emptyA).indexOf('NOVA') < 0 && JSON.stringify(emptyA).indexOf('九千万') < 0);

  // (b) 权限：只有作者能放行；母稿没有按段放行
  const errReviewer = await svc.releaseParagraph(pa.id, 0, 'reviewer', 1).then(() => null, e => e);
  ok('审阅人不能放行', errReviewer && errReviewer.status === 403);
  const errMaster = await svc.releaseParagraph(pm.id, 0, 'author', 1).then(() => null, e => e);
  ok('母稿不支持按段放行', errMaster && errMaster.status === 400);

  // (c) 甲只放第二段；外面只有放行时遮完后的字，没有别的段
  await svc.releaseParagraph(pa.id, 1, 'author', 1);
  let extA = await svc.external(pa.id);
  ok('只放第二段：外面只见这一段', extA.content === '二段：代号NOVA八，先放行。');
  ok('外面没有第一/三段', !extA.content.includes('公开内容甲') && !extA.content.includes('九千万'));
  // 乙一份没放，不能被甲带着亮
  ok('两份投放稿各放各的：乙仍为空', (await svc.external(pb.id)).content === '');

  // (d) 放行后内部改正文（第二段、第三段），外面不变
  const paDoc = await svc.getDoc(pa.id);
  await svc.editContent(pa.id,
    paDoc.content.replace('先放行', '先放行（内部修订）').replace('九千万', '九千万整'),
    'author', paDoc.version);
  extA = await svc.external(pa.id);
  ok('放行后内部改文不外流', extA.content === '二段：代号NOVA八，先放行。');

  // (e) 放行后母稿确认新遮罩，已放行那段对应那处也跟着遮；其他相同字不连坐
  const pmDoc = await svc.getDoc(pm.id);
  const nPos = cpIndexOf(pmDoc.content, 'NOVA');
  await svc.addAnnotation({ docId: pm.id, kind: 'mask', start: nPos, end: nPos + 4, note: '' }, 'reviewer', pmDoc.version);
  await svc.confirmMasks(pm.id, null, 'reviewer', pmDoc.version);
  extA = await svc.external(pa.id);
  ok('母稿新遮罩追加到已放行段', !extA.content.includes('NOVA') && extA.content.includes('████'));
  ok('追加遮罩只遮对应那处，上下文不动', extA.content === '二段：代号████八，先放行。');
  ok('乙没放行 → 外面读不到任何字（包括被遮段）', (await svc.external(pb.id)).content === '');

  // (f) 已经放行的段不能收回，也不能重复放行刷新
  const paDoc2 = await svc.getDoc(pa.id);
  const relIdx = paDoc2.releases[0].currentIndex; // 母稿遮罩后段落位置跟随
  const errAgain = await svc.releaseParagraph(pa.id, relIdx, 'author', paDoc2.version).then(() => null, e => e);
  ok('同段重复放行被拒', errAgain && errAgain.status === 409);
  const errBadPara = await svc.releaseParagraph(pa.id, 99, 'author', paDoc2.version).then(() => null, e => e);
  ok('段号越界被拒', errBadPara && errBadPara.status === 400);

  // (g) 乙放行第一段：甲没有的段不会在乙出现，乙也不会因此亮甲的段
  await svc.releaseParagraph(pb.id, 0, 'author', (await svc.getDoc(pb.id)).version);
  const extB = await svc.external(pb.id);
  ok('乙只亮乙放的段', extB.content.includes('公开内容甲') && !extB.content.includes('九千万'));
  ok('甲的对外稿不受乙放行影响', (await svc.external(pa.id)).content === extA.content);

  // (h) 投放稿自己确认的遮罩也追加进放行快照
  let pbDoc = await svc.getDoc(pb.id);
  const jPos = cpIndexOf(pbDoc.content, '公开');
  await svc.addAnnotation({ docId: pb.id, kind: 'mask', start: jPos, end: jPos + 2, note: '' }, 'reviewer', pbDoc.version);
  pbDoc = await svc.getDoc(pb.id);
  await svc.confirmMasks(pb.id, null, 'reviewer', pbDoc.version);
  const extB2 = await svc.external(pb.id);
  ok('本稿确认遮罩也遮掉已放行段', !extB2.content.includes('公开') && extB2.content.includes('██'));
  ok('本稿遮罩不写回母稿', (await svc.getDoc(pm.id)).content.includes('公开内容甲'));

  // (i) 逐段放行后多段按当前段序拼接；被内部改过的未放行段不放行就不亮
  const paDoc3 = await svc.getDoc(pa.id);
  await svc.releaseParagraph(pa.id, 0, 'author', paDoc3.version); // 第一段
  // 第三段已被内部修订过（九千万整），仍可放行；放行看到的是放行时刻遮后的字
  const paDoc4 = await svc.getDoc(pa.id);
  const thirdIdx = paDoc4.paragraphs.length - 1;
  await svc.releaseParagraph(pa.id, thirdIdx, 'author', paDoc4.version);
  const extA3 = await svc.external(pa.id);
  const lines = extA3.content.split('\n');
  ok('三段都放行后按段序呈现', lines.length === 3 && lines[0].includes('公开内容甲')
    && lines[1].includes('代号████') && lines[2].includes('九千万整'));

  // (j) 落盘文件里：未放行段的原文在数据文件中仍在（内部要能改），
  //     但已被遮的字在正文与所有放行记录里都搜不到
  const raw3 = fs.readFileSync(path.join(tmp, 'data.json'), 'utf8');
  ok('落盘无已遮字 NOVA（含放行记录）', !raw3.includes('NOVA'));
  ok('未放行但未遮的内部字仍留在服务端数据里', raw3.includes('九千万整'));
  const relEvents = await svc.events(pa.id);
  ok('历史有放行/追加遮罩事件且不含被遮字',
    relEvents.some(e => e.type === 'paragraph.released')
    && relEvents.some(e => e.type === 'release.scrubbed')
    && !JSON.stringify(relEvents).includes('NOVA'));

  console.log('23) 放行快照不被“放开遮罩”类操作复活：外部可见字单调不增');
  // 母稿没有删除遮罩块的能力（validateAuthorEdit 拒绝）；再验证一次放行段上的块不可删
  const paNow = await svc.getDoc(pa.id);
  const errDelBlock = await svc.editContent(pa.id, paNow.content.replace('⟦████⟧', ''), 'author', paNow.version)
    .then(() => null, e => e);
  ok('放行段内遮罩块同样不可删除', errDelBlock && errDelBlock.status === 400);
  const extStable = await svc.external(pa.id);
  ok('外面读到的仍是遮后版本', !extStable.content.includes('NOVA') && extStable.content.includes('████'));

  console.log('24) 同一次确认里多个遮罩命中同一放行段：快照逐处抹对、不漂移');
  const mMulti = await svc.createDoc('多遮母稿', '代号AAA无关代号BBB无关代号CCC。', 'author');
  const kMulti = await svc.deriveDoc(mMulti.id, '多遮投放稿', 'author');
  await svc.releaseParagraph(kMulti.id, 0, 'author', 1);
  const mmDoc = await svc.getDoc(mMulti.id);
  for (const token of ['AAA', 'BBB', 'CCC']) {
    const pp = cpIndexOf(mmDoc.content, token);
    await svc.addAnnotation({ docId: mMulti.id, kind: 'mask', start: pp, end: pp + 3, note: '' }, 'reviewer', mmDoc.version);
  }
  await svc.confirmMasks(mMulti.id, null, 'reviewer', mmDoc.version);
  const extMulti = await svc.external(kMulti.id);
  ok('三处都抹对、上下文不动', extMulti.content === '代号███无关代号███无关代号███。');
  const rawMulti = fs.readFileSync(path.join(tmp, 'data.json'), 'utf8');
  ok('落盘无 AAA/BBB/CCC', !rawMulti.includes('AAA') && !rawMulti.includes('BBB') && !rawMulti.includes('CCC'));

  console.log(`\n全部通过：${passed} 项断言`);
}
main().catch(e => { console.error('测试失败:', e); process.exit(1); });
