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
  env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile, AUTHOR_PASSWORD: 'apw', REVIEWER_PASSWORD: 'rpw' },
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
    ok('登录成功', (await req('author', 'GET', '/api/me')).body.role === 'author');
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
    const m1 = await req('reviewer', 'POST', `/api/docs/${id}/annotations`,
      { kind: 'mask', start: x, end: x + 6, version: 1 });
    ok('批注与遮罩提议创建', c1.status === 201 && m1.status === 201);

    // 打回
    const rej = await req('author', 'POST', `/api/docs/${id}/annotations/${c1.body.id}/resolve`,
      { action: 'reject', version: 1 });
    ok('打回后原文不变', rej.body.doc.content === text);

    // 改原文（句首插入），遮罩跟随
    const edit = await req('author', 'PUT', `/api/docs/${id}/content`,
      { content: '尊敬的' + text, version: 1 });
    ok('改原文成功 v2', edit.body.version === 2);
    let anns = (await req('reviewer', 'GET', `/api/docs/${id}/annotations`)).body;
    const moved = anns.find(a => a.id === m1.body.id);
    ok('遮罩提议跟随且仍覆盖 X-7788', moved.status === 'proposed' && moved.covered === 'X-7788');

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

    // 预览
    const prev = await req('reviewer', 'POST', `/api/docs/${id}/masks/preview`, {});
    ok('预览抹掉 X-7788', !prev.body.preview.includes('X-7788') && prev.body.preview.includes('██████'));
    ok('预览不改原文', (await req('reviewer', 'GET', `/api/docs/${id}`)).body.content.includes('X-7788'));

    // 确认
    const v = (await req('reviewer', 'GET', `/api/docs/${id}`)).body.version;
    const conf = await req('reviewer', 'POST', `/api/docs/${id}/masks/confirm`, { version: v });
    ok('确认成功', conf.status === 200);
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
    await req('reviewer', 'POST', `/api/docs/${mid}/annotations`,
      { kind: 'mask', start: tPos, end: tPos + 10, version: 1 });
    let vv = (await req('reviewer', 'GET', `/api/docs/${mid}`)).body.version;
    await req('reviewer', 'POST', `/api/docs/${mid}/masks/confirm`, { version: vv });
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
    await req('reviewer', 'POST', `/api/docs/${mid}/annotations`,
      { kind: 'mask', start: pPos, end: pPos + 4, version: mCur2.version });
    vv = (await req('reviewer', 'GET', `/api/docs/${mid}`)).body.version;
    await req('reviewer', 'POST', `/api/docs/${mid}/masks/confirm`, { version: vv });
    const kCur2 = (await req('reviewer', 'GET', `/api/docs/${kid}`)).body;
    ok('投放稿跟着遮掉同一段', !kCur2.content.includes('三段更新') && kCur2.content.includes('⟦████⟧'));

    // 投放稿对外稿：未逐段放行时完全为空（免登录也拿不到任何字）
    const kEmpty = (await req(null, 'GET', `/api/docs/${kid}/external`)).body;
    ok('未放行：投放稿对外稿为空', kEmpty.content === '' && kEmpty.released === 0);

    // 投放稿自己确认遮罩，不写回母稿
    const kCur3 = (await req('reviewer', 'GET', `/api/docs/${kid}`)).body;
    const sPos = cpIndexOf(kCur3.content, '首段公开');
    await req('reviewer', 'POST', `/api/docs/${kid}/annotations`,
      { kind: 'mask', start: sPos, end: sPos + 4, version: kCur3.version });
    vv = (await req('reviewer', 'GET', `/api/docs/${kid}`)).body.version;
    await req('reviewer', 'POST', `/api/docs/${kid}/masks/confirm`, { version: vv });
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
    await req('reviewer', 'POST', `/api/docs/${mid}/annotations`,
      { kind: 'mask', start: tailPos, end: tailPos + 1, version: mNow.version });
    const mNow2 = (await req('reviewer', 'GET', `/api/docs/${mid}`)).body;
    await req('reviewer', 'POST', `/api/docs/${mid}/masks/confirm`, { version: mNow2.version });
    const kExtAfter = (await req(null, 'GET', `/api/docs/${kid}/external`)).body;
    ok('放行后母稿新遮罩追加生效', !kExtAfter.content.includes('尾') && kExtAfter.content.includes('█'));
    ok('另一份仍为空，不被带着亮', (await req(null, 'GET', `/api/docs/${kid2}/external`)).body.content === '');

    ok('落盘文件无被遮文字',
      !fs.readFileSync(dataFile, 'utf8').includes('TOPSECRET9') && !fs.readFileSync(dataFile, 'utf8').includes('三段更新'));

    console.log(`\nHTTP 端到端全部通过：${passed} 项`);
  } finally {
    srv.kill();
  }
})().catch(e => { console.error('失败:', e); srv.kill(); process.exit(1); });
