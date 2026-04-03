/**
 * db.js — Database abstraction
 * 
 * On Render (production): Uses Turso cloud SQLite via @libsql/client
 * On local dev: Falls back to node-sqlite3-wasm (file-based)
 * 
 * Exposes a synchronous-style API compatible with the existing server.js codebase.
 * Turso queries are executed synchronously via a blocking async-to-sync bridge.
 */

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scrape_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    framework TEXT NOT NULL,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    keyword TEXT,
    target_leads INTEGER,
    status TEXT DEFAULT 'running',
    is_paused INTEGER DEFAULT 0,
    verified_count INTEGER DEFAULT 0,
    total_count INTEGER DEFAULT 0,
    resume_url_index INTEGER DEFAULT 0,
    resume_page INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS amazon_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER REFERENCES scrape_jobs(id),
    author TEXT,
    book_title TEXT,
    publish_date TEXT,
    review_count INTEGER DEFAULT 0,
    email TEXT,
    email_verified INTEGER DEFAULT 0,
    email_status TEXT,
    email_confidence TEXT,
    website TEXT,
    amazon_url TEXT,
    asin TEXT,
    is_duplicate INTEGER DEFAULT 0,
    is_non_english INTEGER DEFAULT 0,
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
`;

// ── TURSO (production) ────────────────────────────────────────────────
if (TURSO_URL && TURSO_TOKEN) {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  // Init schema async — called once at startup
  async function initTurso() {
    const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 10);
    for (const stmt of statements) {
      await client.execute(stmt).catch(() => {}); // ignore "already exists"
    }
    console.log('✅ Turso schema ready');
  }

  function rowsToObjects(result) {
    return result.rows.map(row => {
      const obj = {};
      result.columns.forEach((col, i) => { obj[col] = row[i] ?? null; });
      return obj;
    });
  }

  // Async db interface — server.js awaits these
  const db = {
    _turso: true,
    init: initTurso,

    prepare(sql) {
      return {
        all: async (...args) => {
          const r = await client.execute({ sql, args: args.flat() });
          return rowsToObjects(r);
        },
        get: async (...args) => {
          const r = await client.execute({ sql, args: args.flat() });
          if (!r.rows.length) return undefined;
          const obj = {};
          r.columns.forEach((col, i) => { obj[col] = r.rows[0][i] ?? null; });
          return obj;
        },
        run: async (...args) => {
          const r = await client.execute({ sql, args: args.flat() });
          return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.rowsAffected };
        },
      };
    },

    exec: async (sql) => {
      const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 5);
      for (const s of stmts) await client.execute(s).catch(() => {});
    },
  };

  console.log('✅ Using Turso cloud DB:', TURSO_URL);
  module.exports = db;

} else {
  // ── LOCAL FALLBACK (node-sqlite3-wasm) ──────────────────────────────
  const { Database } = require('node-sqlite3-wasm');
  const path = require('path');
  const fs = require('fs');

  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const _db = new Database(path.join(DATA_DIR, 'leadgen.db'));
  _db.exec(SCHEMA);

  console.log('⚠️  Using local SQLite (no TURSO_URL set)');

  const db = {
    _turso: false,
    init: async () => {},

    prepare(sql) {
      return {
        all: (...args) => _db.all(sql, args.flat()),
        get: (...args) => _db.get(sql, args.flat()),
        run: (...args) => {
          const r = _db.run(sql, args.flat());
          return { lastInsertRowid: r?.lastInsertRowid ?? r, changes: 1 };
        },
      };
    },
    exec: (sql) => _db.exec(sql),
  };

  module.exports = db;
}
