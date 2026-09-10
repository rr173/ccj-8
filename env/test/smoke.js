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

  console.log(`\n全部通过：${passed} 项断言`);
}
main().catch(e => { console.error('测试失败:', e); process.exit(1); });
