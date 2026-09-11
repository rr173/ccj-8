'use strict';
// HTTP 服务：登录态（HMAC 签名 cookie）、REST API、静态前端

const path = require('path');
const fs = require('fs');
const express = require('express');
const { JsonStore } = require('./store');
const { Service, httpError } = require('./domain');
const { verifyPassword, sign, unsign } = require('./util');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_FILE = process.env.DATA_FILE || '/data/review.json';
const COOKIE_NAME = 'rv_session';

const app = express();
app.use(express.json({ limit: '2mb' }));

const store = new JsonStore(DATA_FILE);
const service = new Service(store);

// 首次启动从环境变量初始化两个账号；未提供则用默认值并在日志提示尽快改密码
const AUTHOR_PW = process.env.AUTHOR_PASSWORD || 'author123';
const REVIEWER_PW = process.env.REVIEWER_PASSWORD || 'reviewer123';
let SECRET = null;

async function boot() {
  SECRET = await service.initUsers(AUTHOR_PW, REVIEWER_PW);
}

// ---------- 认证 ----------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}
function currentUser(req) {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  else token = parseCookies(req)[COOKIE_NAME];
  const payload = token && SECRET ? unsign(token, SECRET) : null;
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return { name: payload.u, role: payload.role };
}
function requireAuth(roles) {
  return (req, res, next) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: '未登录或登录已过期' });
    if (roles && !roles.includes(u.role)) return res.status(403).json({ error: '没有操作权限' });
    req.user = u;
    next();
  };
}

app.post('/api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    const user = await service.getUser(username);
    if (!user || !verifyPassword(password, user.passHash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = sign({ u: username, role: user.role, exp: Date.now() + 1000 * 60 * 60 * 12 }, SECRET);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`);
    res.json({ username, role: user.role });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth(), (req, res) => res.json(req.user));

// ---------- 文档 ----------
app.get('/api/docs', requireAuth(), async (req, res, next) => {
  try { res.json(await service.listDocs()); } catch (e) { next(e); }
});

app.post('/api/docs', requireAuth(['author']), async (req, res, next) => {
  try {
    const title = String(req.body.title || '').slice(0, 200) || '无标题文案';
    const content = String(req.body.content || '');
    if (content.includes('⟦') || content.includes('⟧')) {
      return res.status(400).json({ error: '正文中不允许使用 ⟦ 或 ⟧ 字符' });
    }
    res.status(201).json(await service.createDoc(title, content, req.user.name));
  } catch (e) { next(e); }
});

app.post('/api/docs/:id/derive', requireAuth(['author']), async (req, res, next) => {
  try {
    res.status(201).json(await service.deriveDoc(req.params.id, req.body && req.body.title, req.user.name));
  } catch (e) { next(e); }
});

app.get('/api/docs/:id', requireAuth(), async (req, res, next) => {
  try {
    const doc = await service.getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: '文档不存在' });
    res.json(doc);
  } catch (e) { next(e); }
});

app.put('/api/docs/:id/content', requireAuth(['author']), async (req, res, next) => {
  try {
    res.json(await service.editContent(req.params.id, String(req.body.content || ''), req.user.name, req.body.version));
  } catch (e) { next(e); }
});

app.post('/api/docs/:id/close', requireAuth(['reviewer']), async (req, res, next) => {
  try { res.json(await service.closeDoc(req.params.id, req.user.name)); }
  catch (e) { next(e); }
});

// 按段放行（仅投放稿、仅作者）：放行后外面只能看到放行时遮完后的字；不可逆
app.post('/api/docs/:id/release', requireAuth(['author']), async (req, res, next) => {
  try {
    const paragraph = Number(req.body && req.body.paragraph);
    res.status(201).json(await service.releaseParagraph(
      req.params.id, paragraph, req.user.name, req.body && req.body.version));
  } catch (e) { next(e); }
});

// 对外稿：无需登录（审阅结束后对外发布的版本）
app.get('/api/docs/:id/external', async (req, res, next) => {
  try { res.json(await service.external(req.params.id)); }
  catch (e) { next(e); }
});

app.get('/api/docs/:id/events', requireAuth(), async (req, res, next) => {
  try { res.json(await service.events(req.params.id)); }
  catch (e) { next(e); }
});

// ---------- 批注 ----------
app.get('/api/docs/:id/annotations', requireAuth(), async (req, res, next) => {
  try { res.json(await service.annotations(req.params.id)); }
  catch (e) { next(e); }
});

app.post('/api/docs/:id/annotations', requireAuth(['reviewer']), async (req, res, next) => {
  try {
    const { kind, start, end, note, replacement } = req.body || {};
    res.status(201).json(await service.addAnnotation(
      { docId: req.params.id, kind, start: Number(start), end: Number(end), note, replacement },
      req.user.name, req.body.version));
  } catch (e) { next(e); }
});

app.post('/api/docs/:id/annotations/:aid/resolve', requireAuth(['author']), async (req, res, next) => {
  try {
    res.json(await service.resolveAnnotation(req.params.id, req.params.aid, req.body.action, req.user.name, req.body.version));
  } catch (e) { next(e); }
});

app.post('/api/docs/:id/annotations/:aid/reposition', requireAuth(['reviewer']), async (req, res, next) => {
  try {
    res.json(await service.repositionAnnotation(
      req.params.id, req.params.aid, Number(req.body.start), Number(req.body.end), req.user.name, req.body.version));
  } catch (e) { next(e); }
});

// ---------- 遮罩 ----------
app.post('/api/docs/:id/masks/preview', requireAuth(['reviewer']), async (req, res, next) => {
  try { res.json(await service.previewMasks(req.params.id, Array.isArray(req.body.ids) ? req.body.ids : null, req.user.name)); }
  catch (e) { next(e); }
});

app.post('/api/docs/:id/masks/confirm', requireAuth(['reviewer']), async (req, res, next) => {
  try {
    res.json(await service.confirmMasks(
      req.params.id, Array.isArray(req.body.ids) ? req.body.ids : null, req.user.name, req.body.version));
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  void next;
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// ---------- 静态前端 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

boot().then(() => {
  // 确保数据目录可写时才监听，给容器编排明确的失败信号
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`文案审阅服务已启动: http://0.0.0.0:${PORT}`);
    console.log(`数据文件: ${DATA_FILE}`);
    if (!process.env.AUTHOR_PASSWORD || !process.env.REVIEWER_PASSWORD) {
      console.log('使用了默认密码（author123 / reviewer123），生产环境请用环境变量覆盖。');
    }
  });
}).catch(e => { console.error(e); process.exit(1); });
