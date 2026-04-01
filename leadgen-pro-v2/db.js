const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const _db = new Database(path.join(DATA_DIR, 'leadgen.db'));

_db.exec(`
  CREATE TABLE IF NOT EXISTS scrape_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    framework TEXT NOT NULL,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    keyword TEXT,
    target_leads INTEGER,
    status TEXT DEFAULT 'running',
    verified_count INTEGER DEFAULT 0,
    total_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS amazon_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER REFERENCES scrape_jobs(id),
    author TEXT,
    book_title TEXT,
    publish_date TEXT,
    email TEXT,
    email_verified INTEGER DEFAULT 0,
    email_status TEXT,
    website TEXT,
    amazon_url TEXT,
    asin TEXT,
    is_duplicate INTEGER DEFAULT 0,
    scraped_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_asin ON amazon_leads(asin);

  CREATE TABLE IF NOT EXISTS intent_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER REFERENCES scrape_jobs(id),
    name TEXT,
    title TEXT,
    description TEXT,
    email TEXT,
    email_verified INTEGER DEFAULT 0,
    email_status TEXT,
    phone TEXT,
    whatsapp TEXT,
    budget TEXT,
    city TEXT,
    source TEXT,
    url TEXT,
    posted_date TEXT,
    is_duplicate INTEGER DEFAULT 0,
    scraped_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_url ON intent_leads(url);

  CREATE TABLE IF NOT EXISTS job_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    level TEXT,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Wrap node-sqlite3-wasm in a better-sqlite3-compatible interface
// so server.js can use db.prepare('...').all/get/run syntax.
const db = {
  prepare(sql) {
    return {
      all(...args) {
        const params = args.flat();
        return _db.all(sql, params);
      },
      get(...args) {
        const params = args.flat();
        return _db.get(sql, params);
      },
      run(...args) {
        const params = args.flat();
        return _db.run(sql, params);
      }
    };
  },
  exec(sql) {
    return _db.exec(sql);
  }
};

module.exports = db;
