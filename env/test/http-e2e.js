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

    console.log(`\nHTTP 端到端全部通过：${passed} 项`);
  } finally {
    srv.kill();
  }
})().catch(e => { console.error('失败:', e); srv.kill(); process.exit(1); });
