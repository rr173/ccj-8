# 对外文案审阅（可逆批注 + 不可逆遮罩）

审阅人在原文网页上划两层标记：

1. **可逆批注层** —— 评论 / 修改建议。作者可以**接受**（修改建议直接替换进原文）或**打回**（原文保持不变）。
2. **不可逆遮罩层** —— 审阅人划出拟遮罩区段，**预览遮罩后的对外稿**，确认后被遮的字从正文和历史中永久抹除：
   - 确认即把正文里的字替换成 `⟦██…⟧` 原子占位符并落盘，不留任何快照、备份、可还原编码；
   - 历史事件只记录“遮罩 N 字”，不含被遮内容；
   - 与遮罩选区重叠的批注一并**封存**（只保留“某条批注被封存”，备注/替换文清空）；
   - 作者再改原文时，已确认遮罩块不能删除、移动、改长度（服务端用 token 级 diff 强校验）；
   - 对外稿接口剥除系统标记，任何人（免登录）只能读到 █。

**批注跟随（不批错行）**：作者在审阅未结束时改原文，服务端对新旧正文跑 code-point 级 Myers diff，所有待处理批注按映射重定位；批注覆盖区内只要有字被删/改，批注即标记为“失去位置”（orphaned），绝不猜位置——审阅人可在网页上一键重新定位。

## 派生投放稿（母稿 → 多份投放稿）

一篇母稿可以派生出多份投放稿，定向投放、各自审阅：

- **派生即同一份字**：派生时正文与母稿完全一致；母稿已确认的遮罩在派生稿里就是遮着的，任何人无法从派生稿读出原文（批注与历史不复制，投放稿有自己的审阅空间）。
- **母稿改未遮的字**：投放稿里没自己改过的地方跟着变成一样；投放稿自己改过的字不被母稿盖掉（先按“段”对齐，两边都改过的段再按“字”三方合并——没有换行的整篇文案也能只跟句首、保住句尾；同一处两边都改以投放稿为准。合并时本稿待处理批注同样跟着位置走）。已冻结的投放稿不再同步文字。
- **母稿确认新遮罩**：所有已派生的投放稿——包括已冻结的——在同一事务里把**对应的那一处**遮掉：按位置映射（token 级 diff），不是按文本匹配——投放稿把那一段改写过的也照遮，对外一个字都读不到；同时只遮对应的这一处，文中其他相同的字不被连坐。传播只向下（母稿 → 投放稿 → 投放稿的投放稿），绝不写回母稿。
- **投放稿是独立审阅文档**：自己的批注 / 建议 / 遮罩 / 打回 / 预览都只动这一份；打回不碰母稿，投放稿上确认的遮罩也不写回母稿；两份投放稿各改各的，互不覆盖。
- **对外稿按份独立**：`/#/ext/<docId>` 看某一份投放稿，只能看到那一份遮完后的字。

## 角色

| 账号 | 能做什么 |
|---|---|
| `author` 作者 | 建文档、派生投放稿、改原文、接受/打回批注、读对外稿 |
| `reviewer` 审阅人 | 划批注/建议/遮罩、预览并确认遮罩、结束审阅 |
| 任何人（免登录） | 只读对外稿 `/#/ext/<docId>` |

## Docker 部署

```bash
# 方式一：docker compose（推荐）
AUTHOR_PASSWORD='强密码A' REVIEWER_PASSWORD='强密码R' docker compose up -d --build

# 方式二：docker
docker build -t copy-review-redact .
docker run -d -p 8080:8080 \
  -e AUTHOR_PASSWORD='强密码A' -e REVIEWER_PASSWORD='强密码R' \
  -v review-data:/data copy-review-redact
```

打开 http://服务器:8080 ，用 `author` / `reviewer` 登录。
不设置密码环境变量时使用默认密码 `author123` / `reviewer123`（仅限试用）。
数据保存在卷 `/data/review.json`。

## 本地开发

```bash
npm install
DATA_FILE=./data/review.json npm start   # http://localhost:8080
npm test                                  # 79 项业务断言 + 34 项 HTTP 端到端断言
```

## API 摘要

- `POST /api/login` · `POST /api/logout` · `GET /api/me`
- `GET/POST /api/docs` · `GET /api/docs/:id`
- `POST /api/docs/:id/derive`（派生投放稿，body 可带 `title`）
- `PUT /api/docs/:id/content`（作者改原文，body 带 `version` 乐观锁；母稿改动会同步进未冻结的投放稿）
- `POST /api/docs/:id/close`（审阅人结束审阅、冻结）
- `GET /api/docs/:id/external`（对外稿，免登录）
- `GET/POST /api/docs/:id/annotations`（kind: comment / suggest / mask）
- `POST /api/docs/:id/annotations/:aid/resolve`（action: accept / reject）
- `POST /api/docs/:id/annotations/:aid/reposition`（失位批注重新定位）
- `POST /api/docs/:id/masks/preview` · `POST /api/docs/:id/masks/confirm`
- `GET /api/docs/:id/events`（历史，只含类型/字数，不含被遮内容）

## 不可逆性的边界说明

系统在应用自身范围内做到“不可恢复”：确认遮罩时唯一的正文被重写、历史不含被遮文字、落盘 JSON 里也搜不到。
部署运维层面仍需自行管理：数据库卷的旧快照、文件系统级备份、浏览器/代理缓存等不在应用控制之内；请在遮罩确认后再对外分发，并对历史备份做相应处理。
