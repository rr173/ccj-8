'use strict';
// JSON 文件存储。单实例部署足够；所有写操作串行化。
// 关键设计：不保留任何被遮罩文字的副本 —— 确认遮罩时直接改写正文，
// 历史只记录“遮罩 N 字”，日志与备份里都没有原文。

const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file) {
    this.file = file;
    this.chain = Promise.resolve();
    this.data = {
      secret: null,
      users: {},          // username -> {passHash, role}
      docs: {},           // id -> document
      counters: { doc: 0, ann: 0, event: 0, release: 0 }
    };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = JSON.parse(raw);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this._flush();
    }
  }

  _flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // 串行化所有读改写事务
  tx(fn) {
    const run = this.chain.then(() => fn(this.data));
    // 无论 fn 成功与否都继续队列；fn 成功则落盘
    this.chain = run.then(() => this._flush(), () => {});
    return run;
  }

  // 只读（也排队，避免与写事务竞争）
  read(fn) {
    return this.chain.then(() => fn(this.data));
  }
}

module.exports = { JsonStore };
