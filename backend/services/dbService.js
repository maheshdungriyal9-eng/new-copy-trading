const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { dataPath } = require('./storageService');

class DbService {
  constructor(filename = dataPath('copy_trading.db')) { this.filename = filename; this.db = null; }
  async init() {
    if (this.db) return;
    if (this.filename !== ':memory:') fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const database = new DatabaseSync(this.filename);
    try {
      database.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, userId TEXT, targetId TEXT NOT NULL, tradeParams TEXT NOT NULL,
          status TEXT NOT NULL, createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT,
          result TEXT, error TEXT, retryCount INTEGER DEFAULT 0, metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, createdAt);
        CREATE INDEX IF NOT EXISTS jobs_target ON jobs(targetId);`);
      this.db = database;
    } catch (error) { database.close(); throw error; }
  }
  async run(sql, params = []) {
    await this.init();
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastID: Number(result.lastInsertRowid) };
  }
  async get(sql, params = []) { await this.init(); return this.db.prepare(sql).get(...params); }
  async all(sql, params = []) { await this.init(); return this.db.prepare(sql).all(...params); }
  async exec(sql) { await this.init(); return this.db.exec(sql); }
  close() { this.db?.close(); this.db = null; }
}
module.exports = new DbService();
module.exports.DbService = DbService;
