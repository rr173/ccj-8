'use strict';
// 可选：向运行中的服务写入一份演示文档（含批注/建议/遮罩提议）
const BASE = process.env.BASE || 'http://127.0.0.1:8080';

async function api(method, url, body, cookie) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const json = await res.json().catch(() => null);
  return { status: res.status, json, setCookie };
}

(async () => {
  const a = await api('POST', '/api/login', { username: 'author', password: process.env.AUTHOR_PASSWORD || 'author123' });
  const r = await api('POST', '/api/login', { username: 'reviewer', password: process.env.REVIEWER_PASSWORD || 'reviewer123' });
  if (a.status !== 200 || r.status !== 200) {
    console.error('登录失败，请检查 AUTHOR_PASSWORD / REVIEWER_PASSWORD 环境变量');
    process.exit(1);
  }
  const rc = 'rv_session=' + r.setCookie.split(';')[0].split('=').slice(1).join('=');
  const ac = 'rv_session=' + a.setCookie.split(';')[0].split('=').slice(1).join('=');

  const content = '各位媒体朋友：我司将于9月发布新品，内部代号Project-Nova的真机参数如下：续航36小时。欢迎报道。';
  const doc = await api('POST', '/api/docs', { title: '演示：新品发布声明（对外稿）', content }, ac);
  const id = doc.json.id;
  const cp = s => Array.from(s);
  const range = sub => {
    const chars = cp(sub);
    const start = cp(content).indexOf(...chars);
    return { start, end: start + chars.length };
  };

  const anns = [
    { kind: 'comment', ...range('各位媒体朋友'), note: '称呼可改为「各位媒体朋友，大家好」' },
    { kind: 'suggest', ...range('将于'), note: '表述更确定些', replacement: '定于' },
    { kind: 'mask', ...range('Project-Nova') },
  ];
  for (const a0 of anns) {
    const res = await api('POST', `/api/docs/${id}/annotations`, { ...a0, version: 1 }, rc);
    console.log(res.status, a0.kind, res.json.covered || '', res.json.error || '');
  }
  console.log('\n演示就绪：');
  console.log('  作者登录  ', BASE, ' （author / 你设置的密码）');
  console.log('  审阅人登录', BASE, ' （reviewer / 你设置的密码）');
  console.log('  对外稿    ', BASE + '/#/ext/' + id);
})();
