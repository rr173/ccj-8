'use strict';
// HTTP 端到端测试：真实起服务、走 cookie 登录与全部 API
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 8099;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-http-'));
const dataFile = path.join(tmp, 'data.json');
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT), DATA_FILE: dataFile,
    AUTHOR_PASSWORD: 'apw', REVIEWER_PASSWORD: 'rpw', REVIEWER2_PASSWORD: 'r2pw',
  },
});

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓', n); passed++; };

function req(role, method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (role) headers.Cookie = `${cookieName}=${jars[role]}`;
  return fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    .then(async res => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers }));
}
const cookieName = 'rv_session';
const jars = {};
// 子串的 code-point 位置（批注/遮罩接口用 code-point 偏移）
function cpIndexOf(s, sub) {
  const i = s.indexOf(sub);
  return i < 0 ? i : Array.from(s.slice(0, i)).length;
}

async function login(role, pw) {
  const res = await req(null, 'POST', '/api/login', { username: role, password: pw });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars[role] = setCookie.split(';')[0].split('=').slice(1).join('=');
  return res;
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/`); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server not ready');
}

// 两位审阅人对同一处选区各点头一次；返回第二次点头的响应（点齐落盘）
async function nodBoth(docId, start, end, version) {
  await req('reviewer', 'POST', `/api/docs/${docId}/masks/nod`, { start, end, version });
  return req('reviewer2', 'POST', `/api/docs/${docId}/masks/nod`, { start, end, version });
}

(async () => {
  srv.stdout.on('data', d => process.env.DEBUG && process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));
  await waitReady();
  try {
    console.log('A) 静态页与认证');
    const home = await fetch(`http://127.0.0.1:${PORT}/`);
    ok('首页 200', home.status === 200);
    ok('首页含挂载点', (await home.text()).includes('contentRender'));
    ok('未登录 401', (await req(null, 'GET', '/api/me')).status === 401);
    ok('错密码 401', (await login('author', 'nope')).status === 401);
    await login('author', 'apw');
    await login('reviewer', 'rpw');
    await login('reviewer2', 'r2pw');
    ok('登录成功', (await req('author', 'GET', '/api/me')).body.role === 'author');
    ok('第二名审阅人角色正确', (await req('reviewer2', 'GET', '/api/me')).body.role === 'reviewer');
    const created0 = await req('author', 'POST', '/api/docs', { title: 'tmp', content: 'x' });
    const forbid = await req('author', 'POST', `/api/docs/${created0.body.id}/annotations`,
      { kind: 'comment', start: 0, end: 1, version: 1 });
    ok('作者不能划批注', forbid.status === 403);

    console.log('B) 完整审阅流');
    const text = '各位用户，内部代号X-7788是未公开产品，请知悉。';
    const created = await req('author', 'POST', '/api/docs', { title: '产品声明', content: text });
    ok('建文档 201', created.status === 201);
    const id = created.body.id;
    const x = Array.from(text).indexOf('X');

    const c1 = await req('reviewer', 'POST', `/api/docs/${id}/annotations`,
      { kind: 'comment', start: 0, end: 4, note: '开头更礼貌', version: 1 });
    const m1 = await req('reviewer', 'POST', `/api/docs/${id}/masks/nod`,
      { start: x, end: x + 6, version: 1 });
    ok('批注与第一次遮罩点头创建', c1.status === 201 && m1.status === 201 && m1.body.outcome === 'waiting');
    // 只有一人点头：正文与对外稿都还读得到
    ok('单人点头不抹字', (await req('reviewer', 'GET', `/api/docs/${id}`)).body.content.includes('X-7788'));
    // 同一人重复点头不算第二人
    const m1dup = await req('reviewer', 'POST', `/api/docs/${id}/masks/nod`, { start: x, end: x + 6, version: 1 });
    ok('同一人重复点头幂等、不点齐', m1dup.body.outcome === 'already-nodded');
    // 第二人范围对不上：不点齐
    const m1mis = await req('reviewer2', 'POST', `/api/docs/${id}/masks/nod`, { start: x, end: x + 5, version: 1 });
    ok('范围对不上不点齐', m1mis.body.outcome === 'waiting' && m1mis.body.applied === false);
    // 作者无权点头
    const m1bad = await req('author', 'POST', `/api/docs/${id}/masks/nod`, { start: x, end: x + 6, version: 1 });
    ok('作者不能点头', m1bad.status === 403);
    // 旧的单人确认接口已下线
    const oldConfirm = await req('reviewer', 'POST', `/api/docs/${id}/masks/confirm`, { version: 1 });
    ok('单人 confirm 接口已下线', oldConfirm.status === 410);

    // 打回
    const rej = await req('author', 'POST', `/api/docs/${id}/annotations/${c1.body.id}/resolve`,
      { action: 'reject', version: 1 });
    ok('打回后原文不变', rej.body.doc.content === text);

    // 改原文（句首插入），遮罩跟随
    const edit = await req('author', 'PUT', `/api/docs/${id}/content`,
      { content: '尊敬的' + text, version: 1 });
    ok('改原文成功 v2', edit.body.version === 2);
    let anns = (await req('reviewer', 'GET', `/api/docs/${id}/annotations`)).body;
    const moved = anns.find(a => a.id === m1.body.annotation.id);
    ok('遮罩点头跟随且仍覆盖 X-7788', moved.status === 'proposed' && moved.covered === 'X-7788');

    // 覆盖区删字 -> 失位
    const c2 = await req('reviewer', 'POST', `/api/docs/${id}/annotations`,
      { kind: 'comment', start: 0, end: 3, note: '会被删字冲掉', version: 2 });
    const cur = (await req('author', 'GET', `/api/docs/${id}`)).body;
    const ch = Array.from(cur.content);
    const delPos = ch.indexOf('尊');
    const deleted = ch.slice(0, delPos).join('') + ch.slice(delPos + 1).join('');
    await req('author', 'PUT', `/api/docs/${id}/content`, { content: deleted, version: 2 });
    anns = (await req('reviewer', 'GET', `/api/docs/${id}/annotations`)).body;
    const orphan = anns.find(a => a.id === c2.body.id);
    ok('覆盖区被删 → orphaned', orphan.status === 'orphaned' && orphan.start === null);

    // 预览（只有第一个审阅人在 X-7788 上有有效点头；第二人那个错范围的点头覆盖 X-778）
    const prev = await req('reviewer', 'POST', `/api/docs/${id}/masks/preview`, {});
    ok('预览抹掉待点头选区', prev.body.preview.includes('██████') && !prev.body.preview.includes('X-7788'));
    ok('预览不改原文', (await req('reviewer', 'GET', `/api/docs/${id}`)).body.content.includes('X-7788'));

    // 第二位审阅人在与第一人完全一致的选区上点头 → 点齐落盘
    const v = (await req('reviewer', 'GET', `/api/docs/${id}`)).body.version;
    const xCur = Array.from((await req('reviewer', 'GET', `/api/docs/${id}`)).body.content).indexOf('X');
    const conf = await req('reviewer2', 'POST', `/api/docs/${id}/masks/nod`,
      { start: xCur, end: xCur + 6, version: v });
    ok('点齐成功', conf.status === 200 && conf.body.outcome === 'confirmed');
    const after = (await req('reviewer', 'GET', `/api/docs/${id}`)).body;
    ok('正文里已无 X-7788', !after.content.includes('X-7788') && after.content.includes('⟦██████⟧'));

    // 历史与落盘
    const events = (await req('reviewer', 'GET', `/api/docs/${id}/events`)).body;
    ok('历史无被遮字符', !JSON.stringify(events).includes('X-7788'));
    ok('历史记录遮罩字数', events.some(e => e.type === 'mask.confirmed' && e.detail.len === 6));
    ok('落盘文件无被遮字符', !fs.readFileSync(dataFile, 'utf8').includes('X-7788'));

    // 对外稿（免登录）
    const ext = (await req(null, 'GET', `/api/docs/${id}/external`)).body;
    ok('对外稿免登录可读', !!ext && !ext.content.includes('X-7788'));
    ok('对外稿无系统标记', !ext.content.includes('⟦') && ext.content.includes('██████'));

    // 已确认遮罩不可删
    const vNow = (await req('author', 'GET', `/api/docs/${id}`)).body.version;
    const badEdit = await req('author', 'PUT', `/api/docs/${id}/content`,
      { content: after.content.replace('⟦██████⟧', ''), version: vNow });
    ok('删遮罩块被拒', badEdit.status === 400);

    // 冻结
    await req('reviewer', 'POST', `/api/docs/${id}/close`, {});
    const frozen = await req('reviewer', 'POST', `/api/docs/${id}/annotations`,
      { kind: 'comment', start: 0, end: 1, note: 'x' });
    ok('冻结后不能批注', frozen.status === 409);

    console.log('C) 派生投放稿（母稿 → 投放稿同步）');
    const mText = '首段公开。二段代号TOPSECRET9尾。\n三段普通。';
    const mc = await req('author', 'POST', '/api/docs', { title: '母稿', content: mText });
    ok('建母稿 201', mc.status === 201);
    const mid = mc.body.id;
    const tPos = cpIndexOf(mText, 'TOPSECRET9');
    const conf0 = await nodBoth(mid, tPos, tPos + 10, 1);
    ok('双人点齐遮罩', conf0.body.outcome === 'confirmed' && conf0.body.applied === true);
    ok('审阅人不能派生', (await req('reviewer', 'POST', `/api/docs/${mid}/derive`, {})).status === 403);
    const der = await req('author', 'POST', `/api/docs/${mid}/derive`, { title: '投放稿A' });
    ok('派生 201', der.status === 201);
    const kid = der.body.id;
    ok('派生稿与母稿同一份字且遮罩已带过去',
      !der.body.content.includes('TOPSECRET9') && der.body.content.includes('⟦██████████⟧'));
    ok('派生稿 parentId 正确', der.body.parentId === mid);
    const listC = (await req('author', 'GET', '/api/docs')).body;
    ok('列表带派生关系', listC.find(d => d.id === mid).derived === 1 && listC.find(d => d.id === kid).parentId === mid);

    // 母稿改未遮的字 → 投放稿跟着变
    const mCur = (await req('author', 'GET', `/api/docs/${mid}`)).body;
    await req('author', 'PUT', `/api/docs/${mid}/content`,
      { content: mCur.content.replace('三段普通', '三段更新'), version: mCur.version });
    const kCur = (await req('reviewer', 'GET', `/api/docs/${kid}`)).body;
    ok('投放稿跟着母稿改字', kCur.content.includes('三段更新'));

    // 母稿确认新遮罩 → 投放稿跟着遮掉同一段
    const mCur2 = (await req('reviewer', 'GET', `/api/docs/${mid}`)).body;
    const pPos = cpIndexOf(mCur2.content, '三段更新');
    await nodBoth(mid, pPos, pPos + 4, mCur2.version);
    const kCur2 = (await req('reviewer', 'GET', `/api/docs/${kid}`)).body;
    ok('投放稿跟着遮掉同一段', !kCur2.content.includes('三段更新') && kCur2.content.includes('⟦████⟧'));

    // 投放稿对外稿：未逐段放行时完全为空（免登录也拿不到任何字）
    const kEmpty = (await req(null, 'GET', `/api/docs/${kid}/external`)).body;
    ok('未放行：投放稿对外稿为空', kEmpty.content === '' && kEmpty.released === 0);

    // 投放稿自己点齐遮罩，不写回母稿
    const kCur3 = (await req('reviewer', 'GET', `/api/docs/${kid}`)).body;
    const sPos = cpIndexOf(kCur3.content, '首段公开');
    await nodBoth(kid, sPos, sPos + 4, kCur3.version);
    ok('投放稿遮罩不写回母稿', (await req('reviewer', 'GET', `/api/docs/${mid}`)).body.content.includes('首段公开'));

    // 按段放行：只有作者能放；逐段放行后外面只看到遮完后的字；不可重复放行
    ok('审阅人不能放行', (await req('reviewer', 'POST', `/api/docs/${kid}/release`, { paragraph: 0 })).status === 403);
    ok('母稿不支持按段放行', (await req('author', 'POST', `/api/docs/${mid}/release`, { paragraph: 0 })).status === 400);
    const kReady = (await req('author', 'GET', `/api/docs/${kid}`)).body;
    const paraCount = kReady.paragraphs.length;
    for (let p = 0; p < paraCount; p++) {
      const cur = (await req('author', 'GET', `/api/docs/${kid}`)).body;
      const r = await req('author', 'POST', `/api/docs/${kid}/release`, { paragraph: p, version: cur.version });
      ok(`第 ${p + 1} 段放行 201`, r.status === 201);
    }
    const dupRel = await req('author', 'POST', `/api/docs/${kid}/release`,
      { paragraph: 0, version: (await req('author', 'GET', `/api/docs/${kid}`)).body.version });
    ok('重复放行被拒（不可收回/刷新）', dupRel.status === 409);
    const kExt = (await req(null, 'GET', `/api/docs/${kid}/external`)).body;
    ok('放行后对外稿只有遮完的字',
      !kExt.content.includes('TOPSECRET9') && !kExt.content.includes('三段更新')
      && !kExt.content.includes('首段公开') && kExt.content.includes('████'));
    ok('对外稿带放行段数', kExt.released === paraCount);

    // 两份投放稿各放各的：另一份没放行，外面必须为空
    const kid2 = (await req('author', 'POST', `/api/docs/${mid}/derive`, { title: '投放稿B' })).body.id;
    ok('另一份未放行对外为空', (await req(null, 'GET', `/api/docs/${kid2}/external`)).body.content === '');
    // 母稿仍整篇对外（按段放行只作用于投放稿）
    const masterExt = (await req(null, 'GET', `/api/docs/${mid}/external`)).body;
    ok('母稿仍整篇对外', masterExt.content.includes('首段公开') && masterExt.released === null);

    // 放行后母稿再确认遮罩：已放行段对应那处外面也读不到
    const mNow = (await req('reviewer', 'GET', `/api/docs/${mid}`)).body;
    const tailPos = cpIndexOf(mNow.content, '尾'); // “二段代号TOPSECRET9尾”里 TOPSECRET9 已遮；遮“尾”字
    await nodBoth(mid, tailPos, tailPos + 1, mNow.version);
    const kExtAfter = (await req(null, 'GET', `/api/docs/${kid}/external`)).body;
    ok('放行后母稿新遮罩追加生效', !kExtAfter.content.includes('尾') && kExtAfter.content.includes('█'));
    ok('另一份仍为空，不被带着亮', (await req(null, 'GET', `/api/docs/${kid2}/external`)).body.content === '');

    ok('落盘文件无被遮文字',
      !fs.readFileSync(dataFile, 'utf8').includes('TOPSECRET9') && !fs.readFileSync(dataFile, 'utf8').includes('三段更新'));

    console.log('D) 渠道回传记账（投放稿对账：干净 / 泄露 / 少发，只追加不可抹）');
    // 用一份新的母稿+投放稿，放行前两段，便于精确断言
    const cbText = '对外可见首段甲。\n二段公开内容乙。\n未放行内部段丙。';
    const cbMc = await req('author', 'POST', '/api/docs', { title: '回传母稿', content: cbText });
    const cbMid = cbMc.body.id;
    const cbKid = (await req('author', 'POST', `/api/docs/${cbMid}/derive`, { title: '回传投放稿' })).body.id;
    for (const p of [0, 1]) {
      const cur = (await req('author', 'GET', `/api/docs/${cbKid}`)).body;
      await req('author', 'POST', `/api/docs/${cbKid}/release`, { paragraph: p, version: cur.version });
    }
    const cbExt = (await req(null, 'GET', `/api/docs/${cbKid}/external`)).body;
    ok('外面此刻只看得见前两段', cbExt.content === '对外可见首段甲。\n二段公开内容乙。' && cbExt.released === 2);

    // 未放行任何段的投放稿不收（另起一份从未放行的）
    const emptyKid = (await req('author', 'POST', `/api/docs/${cbMid}/derive`, { title: '未放行稿' })).body.id;
    const gate = await req('author', 'POST', `/api/docs/${emptyKid}/callbacks`, { channel: '渠道X', content: 'x' });
    ok('外面还看不见字 → 409 不收回传', gate.status === 409);
    ok('母稿不收回传', (await req('author', 'POST', `/api/docs/${cbMid}/callbacks`, { channel: 'X', content: cbText })).status === 400);
    ok('审阅人不能登记回传', (await req('reviewer', 'POST', `/api/docs/${cbKid}/callbacks`,
      { channel: '渠道X', content: cbExt.content })).status === 403);
    ok('未登录不能登记', (await req(null, 'POST', `/api/docs/${cbKid}/callbacks`,
      { channel: '渠道X', content: cbExt.content })).status === 401);
    const noChan = await req('author', 'POST', `/api/docs/${cbKid}/callbacks`, { channel: '  ', content: cbExt.content });
    ok('不写渠道 → 400', noChan.status === 400);

    // 干净回传
    const clean = await req('author', 'POST', `/api/docs/${cbKid}/callbacks`, { channel: '渠道甲', content: cbExt.content });
    ok('干净回传 201 且 clean', clean.status === 201 && clean.body.callback.clean === true
      && clean.body.callback.seq === 1 && clean.body.leakFragments.length === 0);

    // 泄露：把外面看不见的第三段也发了
    const leak = await req('author', 'POST', `/api/docs/${cbKid}/callbacks`, { channel: '渠道乙', content: cbText });
    ok('夹带未放行段：泄露且非少发', leak.status === 201 && leak.body.callback.clean === false
      && leak.body.callback.leak.count >= 1 && leak.body.callback.missing.length === 0
      && JSON.stringify(leak.body.leakFragments).includes('未放行内部段丙'));

    // 少发：只回传第一段（第二段整段缺席）
    const short = await req('author', 'POST', `/api/docs/${cbKid}/callbacks`, { channel: '渠道乙', content: '对外可见首段甲。' });
    ok('缺了整段已可见的字：少发一笔', short.body.callback.missing.length === 1
      && short.body.callback.missing[0].index === 1);

    // 母稿遮掉“公开”，渠道回传仍带旧字 → 泄露；落盘文件不含该字
    const cbMCur = (await req('reviewer', 'GET', `/api/docs/${cbMid}`)).body;
    const gPos = cpIndexOf(cbMCur.content, '公开');
    await nodBoth(cbMid, gPos, gPos + 2, cbMCur.version);
    const cbExt2 = (await req(null, 'GET', `/api/docs/${cbKid}/external`)).body;
    ok('遮罩后外面读不到“公开”', !cbExt2.content.includes('公开') && cbExt2.content.includes('██'));
    const leakMask = await req('author', 'POST', `/api/docs/${cbKid}/callbacks`,
      { channel: '渠道甲', content: '对外可见首段甲。\n二段公开内容乙。' });
    ok('回传出现外面已看不见的“公开”：泄露', leakMask.body.callback.clean === false
      && JSON.stringify(leakMask.body.leakFragments).includes('公开'));
    ok('泄露的字不进回传账（只存指纹/字数）',
      !JSON.stringify(JSON.parse(fs.readFileSync(dataFile, 'utf8')).callbacks[cbKid]).includes('公开'));

    // 渠道甲再回一次干净的：旧泄露仍在
    const clean2 = await req('author', 'POST', `/api/docs/${cbKid}/callbacks`, { channel: '渠道甲', content: cbExt2.content });
    ok('再回传干净本笔 seq=3', clean2.body.callback.seq === 3 && clean2.body.callback.clean === true);
    const chanA = (await req('author', 'GET', `/api/docs/${cbKid}/callbacks?channel=${encodeURIComponent('渠道甲')}`)).body;
    ok('能查该渠道回过几次、有过泄露', chanA.count === 3
      && chanA.summary[0].leakCallbacks === 1 && chanA.summary[0].count === 3);
    const chanB = (await req('author', 'GET', `/api/docs/${cbKid}/callbacks?channel=${encodeURIComponent('渠道乙')}`)).body;
    ok('渠道乙两笔：泄露 1、少发 1', chanB.summary[0].leakCallbacks === 1 && chanB.summary[0].missingCallbacks === 1);
    const allCb = (await req('reviewer', 'GET', `/api/docs/${cbKid}/callbacks`)).body;
    ok('审阅人也能查全部回传（分渠道汇总）', allCb.count === 5 && allCb.summary.length === 2);
    ok('未知渠道查询 404', (await req('author', 'GET', `/api/docs/${cbKid}/callbacks?channel=无`)).status === 404);

    console.log('E) 已遮代号按原文送回：只标脏，不把还在的段标成少发');
    const codeText = '代号VULCAN-77是机密。\n第二段普通内容。';
    const eMc = await req('author', 'POST', '/api/docs', { title: '代号母稿', content: codeText });
    const eMid = eMc.body.id;
    const eKid = (await req('author', 'POST', `/api/docs/${eMid}/derive`, { title: '代号投放稿' })).body.id;
    const ePos = cpIndexOf(codeText, 'VULCAN-77');
    await nodBoth(eMid, ePos, ePos + 'VULCAN-77'.length, 1);
    await req('author', 'POST', `/api/docs/${eKid}/release`, { paragraph: 0 });
    const eExt = (await req(null, 'GET', `/api/docs/${eKid}/external`)).body;
    ok('外面代号已遮、上下文在', eExt.content === `代号${'█'.repeat('VULCAN-77'.length)}是机密。`);
    // 渠道按原文整段送回
    const eCb = await req('author', 'POST', `/api/docs/${eKid}/callbacks`,
      { channel: '渠道甲', content: '代号VULCAN-77是机密。' });
    ok('按原文送回：泄露标记', eCb.body.callback.clean === false
      && JSON.stringify(eCb.body.leakFragments).includes('VULCAN-77'));
    ok('按原文送回：不标少发（段还在）', eCb.body.callback.missing.length === 0);
    ok('送回的代号不落盘',
      !JSON.stringify(JSON.parse(fs.readFileSync(dataFile, 'utf8')).callbacks[eKid]).includes('VULCAN-77'));
    // 真·整段缺席仍要记少发
    const eMiss = await req('author', 'POST', `/api/docs/${eKid}/callbacks`,
      { channel: '渠道乙', content: '第二段普通内容。' });
    ok('第一段缺席：记少发', eMiss.body.callback.missing.length === 1
      && eMiss.body.callback.missing[0].index === 0);

    console.log('F) 渠道召回令（点名渠道抽段；拒不召回只追加不可抹）');
    const rcText = '召回首段甲。\n召回二段乙。\n召回三段丙。';
    const rcMc = await req('author', 'POST', '/api/docs', { title: '召回母稿', content: rcText });
    const rcMid = rcMc.body.id;
    const rcKid = (await req('author', 'POST', `/api/docs/${rcMid}/derive`, { title: '召回投放稿' })).body.id;
    for (const p of [0, 1, 2]) {
      const cur = (await req('author', 'GET', `/api/docs/${rcKid}`)).body;
      await req('author', 'POST', `/api/docs/${rcKid}/release`, { paragraph: p, version: cur.version });
    }
    const rcFull = (await req(null, 'GET', `/api/docs/${rcKid}/external`)).body;
    ok('召回前三段全在', rcFull.content === rcText);

    // 门槛：审阅人无权 / 母稿不收 / 未放行段写不进 / 重复召回拒
    ok('审阅人不能下召回令', (await req('reviewer', 'POST', `/api/docs/${rcKid}/recalls`,
      { channel: '渠道甲', paragraphs: [0] })).status === 403);
    ok('未登录不能下召回令', (await req(null, 'POST', `/api/docs/${rcKid}/recalls`,
      { channel: '渠道甲', paragraphs: [0] })).status === 401);
    ok('母稿不支持召回令', (await req('author', 'POST', `/api/docs/${rcMid}/recalls`,
      { channel: '渠道甲', paragraphs: [0] })).status === 400);
    ok('召回必须写明渠道', (await req('author', 'POST', `/api/docs/${rcKid}/recalls`,
      { paragraphs: [0] })).status === 400);
    ok('召回必须点名段落', (await req('author', 'POST', `/api/docs/${rcKid}/recalls`,
      { channel: '渠道甲', paragraphs: [] })).status === 400);
    const rcOther = (await req('author', 'POST', `/api/docs/${rcMid}/derive`, { title: '召回另稿' })).body.id;
    await req('author', 'POST', `/api/docs/${rcOther}/release`, { paragraph: 0 });
    ok('没放行过的段写不进召回令', (await req('author', 'POST', `/api/docs/${rcOther}/recalls`,
      { channel: '渠道甲', paragraphs: [1] })).status === 400);

    // 对渠道甲召回第二段
    const rcVer = (await req('author', 'GET', `/api/docs/${rcKid}`)).body.version;
    const order = await req('author', 'POST', `/api/docs/${rcKid}/recalls`,
      { channel: '渠道甲', paragraphs: [1], version: rcVer });
    ok('召回令 201', order.status === 201 && order.body.order.paragraphs.join(',') === '1');
    const vA = (await req(null, 'GET', `/api/docs/${rcKid}/external?channel=${encodeURIComponent('渠道甲')}`)).body;
    ok('被点名渠道视图抽掉召回段', vA.content === '召回首段甲。\n召回三段丙。'
      && !vA.content.includes('召回二段乙'));
    const vB = (await req(null, 'GET', `/api/docs/${rcKid}/external?channel=${encodeURIComponent('渠道乙')}`)).body;
    ok('未点名渠道仍按放行的看', vB.content === rcText);
    const vPub = (await req(null, 'GET', `/api/docs/${rcKid}/external`)).body;
    ok('公开口径不变', vPub.content === rcText);
    ok('同渠道同段只能召回一次', (await req('author', 'POST', `/api/docs/${rcKid}/recalls`,
      { channel: '渠道甲', paragraphs: [1] })).status === 409);

    // 回传：渠道甲夹带被召回段 → 泄露 + 拒不召回
    const cbBad = await req('author', 'POST', `/api/docs/${rcKid}/callbacks`,
      { channel: '渠道甲', content: rcText });
    ok('夹带被召回段：不干净、记拒不召回', cbBad.body.callback.clean === false
      && cbBad.body.callback.refusals.length === 1
      && cbBad.body.callback.refusals[0].paragraph === 1
      && cbBad.body.callback.leak.chars > 0);
    // 渠道丙（没被点名）同样的字 → 干净、无拒不召回
    const cbOther = await req('author', 'POST', `/api/docs/${rcKid}/callbacks`,
      { channel: '渠道丙', content: rcText });
    ok('没被点名的渠道不连坐', cbOther.body.callback.clean === true
      && cbOther.body.callback.refusals.length === 0);
    // 渠道甲合规回传：本笔干净，旧账仍在
    const cbGood = await req('author', 'POST', `/api/docs/${rcKid}/callbacks`,
      { channel: '渠道甲', content: vA.content });
    ok('按召回后视图回传：本笔干净', cbGood.body.callback.clean === true);
    const ledgerA = (await req('reviewer', 'GET',
      `/api/docs/${rcKid}/recalls?channel=${encodeURIComponent('渠道甲')}`)).body;
    ok('审阅人也能查召回账；拒不召回只追加', ledgerA.channels[0].refusalCallbacks === 1
      && ledgerA.channels[0].refusals[0].seq === 1
      && ledgerA.channels[0].recalledParagraphs.join(',') === '1');
    const sumA = (await req('author', 'GET',
      `/api/docs/${rcKid}/callbacks?channel=${encodeURIComponent('渠道甲')}`)).body;
    ok('回传分渠道汇总带拒不召回笔数', sumA.summary[0].refusalCallbacks === 1);
    // 另一个渠道对同一段也下召回令：渠道间互不连坐
    await req('author', 'POST', `/api/docs/${rcKid}/recalls`, { channel: '渠道乙', paragraphs: [1] });
    const cbBadB = await req('author', 'POST', `/api/docs/${rcKid}/callbacks`,
      { channel: '渠道乙', content: rcText });
    ok('渠道乙召回后夹带：记拒不召回', cbBadB.body.callback.refusals.length === 1);
    const cbC2 = await req('author', 'POST', `/api/docs/${rcKid}/callbacks`,
      { channel: '渠道丙', content: rcText });
    ok('渠道丙两笔都干净（这份下过召回也不连坐未点名渠道）', cbC2.body.callback.clean === true);
    const ledgerAll = (await req('author', 'GET', `/api/docs/${rcKid}/recalls`)).body;
    ok('召回账可查全部渠道/段号/拒不召回', ledgerAll.orders.length === 2
      && ledgerAll.channels.filter(g => g.refusalCount > 0).length === 2);
    // 召回不改正文：内部视图仍是原文
    ok('召回不改正文', (await req('author', 'GET', `/api/docs/${rcKid}`)).body.content.includes('召回二段乙'));
    // 文档视图带召回令
    ok('文档视图带召回令', (await req('author', 'GET', `/api/docs/${rcKid}`)).body.recalls.length === 2);

    console.log('G) 泄露事故单（作者对已记泄露开单；任何渠道对得上的字抽空；不可改撤/重复）');
    const inText = '事故首段甲。\n事故二段乙。\n事故三段丙。';
    const inMc = await req('author', 'POST', '/api/docs', { title: '事故母稿', content: inText });
    const inMid = inMc.body.id;
    const inKid = (await req('author', 'POST', `/api/docs/${inMid}/derive`, { title: '事故投放稿' })).body.id;
    // 放行第一、三段，第二段未放行
    await req('author', 'POST', `/api/docs/${inKid}/release`, { paragraph: 0 });
    await req('author', 'POST', `/api/docs/${inKid}/release`, { paragraph: 2 });
    const inExtBefore = (await req(null, 'GET', `/api/docs/${inKid}/external`)).body;
    ok('开单前外面只有一、三段', inExtBefore.content === '事故首段甲。\n事故三段丙。');

    // 门槛：未登录/审阅人不能开；母稿不能开
    ok('未登录不能开事故单', (await req(null, 'POST', `/api/docs/${inKid}/incidents`,
      { callbackId: 'cb_x', leakIndex: 0, fragment: 'x' })).status === 401);
    ok('审阅人不能开事故单', (await req('reviewer', 'POST', `/api/docs/${inKid}/incidents`,
      { callbackId: 'cb_x', leakIndex: 0, fragment: 'x' })).status === 403);
    ok('母稿不能开事故单', (await req('author', 'POST', `/api/docs/${inMid}/incidents`,
      { callbackId: 'cb_x', leakIndex: 0, fragment: 'x' })).status === 400);

    // 渠道甲夹带第二段回传 → 泄露
    const inCb = await req('author', 'POST', `/api/docs/${inKid}/callbacks`,
      { channel: '渠道甲', content: inText });
    ok('夹带未放行段：泄露', inCb.body.callback.leak.count === 1
      && JSON.stringify(inCb.body.leakFragments).includes('二段乙'));
    const inCbId = inCb.body.callback.id;
    const inFrag = inCb.body.leakFragments[0];
    // 不存在的回传/越界泄露号/指纹对不上
    ok('不存在的回传 404', (await req('author', 'POST', `/api/docs/${inKid}/incidents`,
      { callbackId: 'cb_999', leakIndex: 0, fragment: inFrag })).status === 404);
    ok('泄露号越界 404', (await req('author', 'POST', `/api/docs/${inKid}/incidents`,
      { callbackId: inCbId, leakIndex: 9, fragment: inFrag })).status === 404);
    ok('片段指纹对不上 409', (await req('author', 'POST', `/api/docs/${inKid}/incidents`,
      { callbackId: inCbId, leakIndex: 0, fragment: '随便几个字' })).status === 409);

    // 开单（缝里还空着，当场不抽字）
    const opened = await req('author', 'POST', `/api/docs/${inKid}/incidents`,
      { callbackId: inCbId, leakIndex: 0, fragment: inFrag });
    ok('事故单 201', opened.status === 201 && opened.body.incident.id.startsWith('in_')
      && opened.body.incident.channel === '渠道甲' && opened.body.vacuumed.length === 0);
    // 同一处不能开两次
    ok('同一处泄露不能开两次', (await req('author', 'POST', `/api/docs/${inKid}/incidents`,
      { callbackId: inCbId, leakIndex: 0, fragment: inFrag })).status === 409);

    // 放行第二段：事故单盯住段缝，立即抽空（留空行，不是方块）
    await req('author', 'POST', `/api/docs/${inKid}/release`, { paragraph: 1 });
    const inPub = (await req(null, 'GET', `/api/docs/${inKid}/external`)).body;
    ok('公开口径对得上的字留空（无字无方块）', inPub.content === '事故首段甲。\n\n事故三段丙。'
      && !inPub.content.includes('事故二段乙') && !inPub.content.includes('█'));
    const inA = (await req(null, 'GET', `/api/docs/${inKid}/external?channel=${encodeURIComponent('渠道甲')}`)).body;
    const inB = (await req(null, 'GET', `/api/docs/${inKid}/external?channel=${encodeURIComponent('渠道乙')}`)).body;
    ok('任何渠道都翻不出原文，且留空而非方块',
      !inA.content.includes('事故二段乙') && !inB.content.includes('事故二段乙')
      && !inA.content.includes('█') && !inB.content.includes('█'));
    ok('对不上的字不跟着抽', inPub.content.includes('事故首段甲') && inPub.content.includes('事故三段丙'));
    // 内部正文不动
    ok('事故不改正文', (await req('author', 'GET', `/api/docs/${inKid}`)).body.content.includes('事故二段乙'));
    // 留空行不被回传对账误记少发：照发抽空后视图 → 干净
    const inEcho = await req('author', 'POST', `/api/docs/${inKid}/callbacks`,
      { channel: '渠道甲', content: inPub.content });
    ok('照发抽空后视图（含空行）：干净、无少发', inEcho.body.callback.clean === true
      && inEcho.body.callback.missing.length === 0 && inEcho.body.callback.leak.count === 0);

    // 查账：开过哪些事故、对着哪些泄露、各渠道看不看得到
    const ledger = (await req('reviewer', 'GET', `/api/docs/${inKid}/incidents`)).body;
    ok('审阅人也能查事故账', ledger.count === 1
      && ledger.incidents[0].callbackId === inCbId
      && ledger.incidents[0].channels.some(c => c.channel === null && c.status === 'masked')
      && ledger.incidents[0].visible === false);
    ok('按渠道过滤事故账', (await req('author', 'GET',
      `/api/docs/${inKid}/incidents?channel=${encodeURIComponent('渠道甲')}`)).body.incidents[0]
      .channels.some(c => c.channel === '渠道甲'));

    // 被召回渠道泄露 → 公开口径也抽（另起一份：四段，召回第二段后全量送回）
    const icText = '连坐首段。\n连坐二段。\n连坐三段。\n连坐四段。';
    const icMc = await req('author', 'POST', '/api/docs', { title: '连坐母稿', content: icText });
    const icKid = (await req('author', 'POST', `/api/docs/${icMc.body.id}/derive`, { title: '连坐投放稿' })).body.id;
    for (const p of [0, 1, 2, 3]) await req('author', 'POST', `/api/docs/${icKid}/release`, { paragraph: p });
    await req('author', 'POST', `/api/docs/${icKid}/recalls`, { channel: '渠道甲', paragraphs: [1] });
    const icCb = await req('author', 'POST', `/api/docs/${icKid}/callbacks`,
      { channel: '渠道甲', content: icText });
    ok('被召回段送回：泄露+拒不召回', icCb.body.callback.refusals.length === 1
      && icCb.body.callback.leak.count >= 1);
    const icRec = (await req('author', 'GET',
      `/api/docs/${icKid}/callbacks?channel=${encodeURIComponent('渠道甲')}`)).body.callbacks[0];
    const gapIdx = icRec.leak.items.findIndex(it => it.locator && it.locator.kind === 'gap');
    const opened2 = await req('author', 'POST', `/api/docs/${icKid}/incidents`,
      { callbackId: icRec.id, leakIndex: gapIdx, fragment: icCb.body.leakFragments[gapIdx] });
    ok('第二张事故单 201', opened2.status === 201 && opened2.body.vacuumed.length === 1);
    const icPub = (await req(null, 'GET', `/api/docs/${icKid}/external`)).body;
    ok('被召回渠道泄露：公开口径该段留空（不是方块）',
      icPub.content === '连坐首段。\n\n连坐三段。\n连坐四段。'
      && !icPub.content.includes('连坐二段') && !icPub.content.includes('█'));

    // 没有改/撤事故单的接口（PUT/DELETE 不存在 → 404）
    ok('没有撤销事故单的接口', (await req('author', 'DELETE',
      `/api/docs/${inKid}/incidents/${opened.body.incident.id}`)).status === 404);

    console.log('I) 齐套批次');
    // 母稿 + 三份投放稿
    const btMc = await req('author', 'POST', '/api/docs', { title: '齐套母稿',
      content: '批次首段甲。\n批次二段乙。\n批次三段丙。' });
    const btA = (await req('author', 'POST', `/api/docs/${btMc.body.id}/derive`, { title: '齐套A' })).body.id;
    const btB = (await req('author', 'POST', `/api/docs/${btMc.body.id}/derive`, { title: '齐套B' })).body.id;
    const btC = (await req('author', 'POST', `/api/docs/${btMc.body.id}/derive`, { title: '齐套C' })).body.id;

    // 门槛：审阅人无权 / 母稿进不了 / 少于两份 / 成员已在批
    ok('审阅人不能收齐套批次', (await req('reviewer', 'POST', '/api/batches', { docIds: [btA, btB] })).status === 403);
    ok('母稿进不了批次', (await req('author', 'POST', '/api/batches', { docIds: [btMc.body.id, btA] })).status === 400);
    ok('少于两份被拒', (await req('author', 'POST', '/api/batches', { docIds: [btA] })).status === 400);
    const btCreated = await req('author', 'POST', '/api/batches', { title: '六月批次', docIds: [btA, btB] });
    ok('收批 201、成员两份、未齐套', btCreated.status === 201
      && btCreated.body.memberCount === 2 && btCreated.body.complete === false);
    const btId = btCreated.body.id;
    ok('一份不能再进另一批', (await req('author', 'POST', '/api/batches', { docIds: [btA, btC] })).status === 409);
    ok('文档视图带批次', (await req('author', 'GET', `/api/docs/${btA}`)).body.batch.id === btId);
    ok('批次列表可查', (await req('reviewer', 'GET', '/api/batches')).body.batches.some(x => x.id === btId));
    ok('批次详情登录可读', (await req('reviewer', 'GET', `/api/batches/${btId}`)).body.paragraphCount === 0);
    ok('批次不存在 404', (await req('author', 'GET', '/api/batches/bt_9999')).status === 404);

    // 免登录对外：还没放齐 → 空
    let btPub = await req(null, 'GET', `/api/batches/${btId}/external`);
    ok('批次对外免登录、未放齐为空', btPub.status === 200 && btPub.body.content === '' && btPub.body.complete === false);
    ok('对外不泄露未放原文/成员正文', JSON.stringify(btPub.body).indexOf('批次首段甲') < 0);

    // 一份放、另一份没放 → 空；两份都放且字一致 → 亮
    await req('author', 'POST', `/api/docs/${btA}/release`, { paragraph: 0 });
    btPub = await req(null, 'GET', `/api/batches/${btId}/external`);
    ok('只一份放：批次外面仍空', btPub.body.content === '' && btPub.body.visible === 0);
    let btDetail = (await req('author', 'GET', `/api/batches/${btId}`)).body;
    ok('查得出 B 还没放到齐（第一段）', JSON.stringify(btDetail.pendingByMember[btB]) === '[0]');
    await req('author', 'POST', `/api/docs/${btB}/release`, { paragraph: 0 });
    btPub = await req(null, 'GET', `/api/batches/${btId}/external`);
    ok('两份字对得上：批次外面亮这段', btPub.body.content === '批次首段甲。' && btPub.body.visible === 1);

    // 第二段各放各的、用词不一样 → 两份原文都不亮
    let aDoc = (await req('author', 'GET', `/api/docs/${btA}`)).body;
    await req('author', 'PUT', `/api/docs/${btA}/content`,
      { content: aDoc.content.replace('批次二段乙。', '批次二段X。'), version: aDoc.version });
    await req('author', 'POST', `/api/docs/${btA}/release`, { paragraph: 1 });
    await req('author', 'POST', `/api/docs/${btB}/release`, { paragraph: 1 });
    btDetail = (await req('author', 'GET', `/api/batches/${btId}`)).body;
    const slot1 = btDetail.paragraphDetails.find(p => p.index === 1);
    ok('用词不一样：mismatch(divergent)', slot1.status === 'mismatch' && slot1.reason === 'divergent');
    btPub = await req(null, 'GET', `/api/batches/${btId}/external`);
    ok('不一致段两份原文都不亮', btPub.body.content === '批次首段甲。'
      && !btPub.body.content.includes('二段X') && !btPub.body.content.includes('二段乙'));

    // 各份把不同的字分别遮掉 → █ 一致后才亮；第三段补放齐 → 齐套
    aDoc = (await req('author', 'GET', `/api/docs/${btA}`)).body;
    const ax = Array.from(aDoc.content).indexOf('X');
    await req('reviewer', 'POST', `/api/docs/${btA}/masks/nod`, { start: ax, end: ax + 1, version: aDoc.version });
    await req('reviewer2', 'POST', `/api/docs/${btA}/masks/nod`, { start: ax, end: ax + 1, version: aDoc.version });
    let bDoc = (await req('author', 'GET', `/api/docs/${btB}`)).body;
    const by = Array.from(bDoc.content).indexOf('乙');
    await req('reviewer', 'POST', `/api/docs/${btB}/masks/nod`, { start: by, end: by + 1, version: bDoc.version });
    await req('reviewer2', 'POST', `/api/docs/${btB}/masks/nod`, { start: by, end: by + 1, version: bDoc.version });
    await req('author', 'POST', `/api/docs/${btA}/release`, { paragraph: 2 });
    await req('author', 'POST', `/api/docs/${btB}/release`, { paragraph: 2 });
    btPub = await req(null, 'GET', `/api/batches/${btId}/external`);
    ok('差异遮齐 + 第三段补放：对外齐套', btPub.body.complete === true && btPub.body.visible === 3
      && btPub.body.content === '批次首段甲。\n批次二段█。\n批次三段丙。'
      && btPub.body.masks.some(m => m.len === 1));
    ok('批次详情也报齐套', (await req('author', 'GET', `/api/batches/${btId}`)).body.complete === true);
    // 没有退出/改批次的接口
    ok('没有退出批次的接口', (await req('author', 'DELETE', `/api/batches/${btId}`)).status === 404);

    console.log(`\nHTTP 端到端全部通过：${passed} 项`);
  } finally {
    srv.kill();
  }
})().catch(e => { console.error('失败:', e); srv.kill(); process.exit(1); });
