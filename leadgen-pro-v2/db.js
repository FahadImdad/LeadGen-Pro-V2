/**
 * db.js — Database abstraction
 *
 * Production: Neon PostgreSQL (persistent, never expires)
 * Local dev:  Falls back to node-sqlite3-wasm (file-based)
 */

const DATABASE_URL = process.env.DATABASE_URL;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS scrape_jobs (
    id SERIAL PRIMARY KEY,
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
    id SERIAL PRIMARY KEY,
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
    publisher TEXT,
    is_duplicate INTEGER DEFAULT 0,
    is_non_english INTEGER DEFAULT 0,
    scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(asin)
  );
  CREATE TABLE IF NOT EXISTS intent_leads (
    id SERIAL PRIMARY KEY,
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
    scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(url)
  );
  CREATE TABLE IF NOT EXISTS job_logs (
    id SERIAL PRIMARY KEY,
    job_id INTEGER NOT NULL,
    level TEXT,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

// ── NEON POSTGRESQL (production) ─────────────────────────────────────────────
if (DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  async function initPg() {
    // Create tables one by one
    const stmts = SCHEMA_PG.split(';').map(s => s.trim()).filter(s => s.length > 10);
    for (const stmt of stmts) {
      await pool.query(stmt).catch(e => {
        if (!e.message.includes('already exists')) console.warn('Schema warning:', e.message);
      });
    }
    console.log('✅ Neon PostgreSQL schema ready');
  }

  // Convert PG result to array of plain objects
  function toRows(result) {
    return result.rows || [];
  }

  const db = {
    _pg: true,
    init: initPg,

    prepare(sql) {
      // Convert SQLite-style ? placeholders to PostgreSQL $1, $2...
      function convertSql(s) {
        let i = 0;
        return s.replace(/\?/g, () => `$${++i}`);
      }

      return {
        all: async (...args) => {
          const r = await pool.query(convertSql(sql), args.flat());
          return toRows(r);
        },
        get: async (...args) => {
          const r = await pool.query(convertSql(sql), args.flat());
          return r.rows[0] || undefined;
        },
        run: async (...args) => {
          // For INSERTs, return lastInsertRowid via RETURNING id
          const pgSql = convertSql(sql);
          const insertSql = /^\s*INSERT/i.test(pgSql)
            ? pgSql.replace(/;?\s*$/, ' RETURNING id')
            : pgSql;
          const r = await pool.query(insertSql, args.flat());
          return {
            lastInsertRowid: r.rows[0]?.id || null,
            changes: r.rowCount
          };
        },
      };
    },

    exec: async (sql) => {
      // Run multiple statements separated by semicolons
      const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 5);
      for (const s of stmts) {
        await pool.query(s).catch(() => {});
      }
    },
  };

  console.log('✅ Using Neon PostgreSQL');
  module.exports = db;

} else if (process.env.TURSO_URL && process.env.TURSO_TOKEN) {
  // ── TURSO (LibSQL — persistent cloud SQLite) ─────────────────────────
  const { createClient } = require('@libsql/client');
  const turso = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN,
  });

  async function initTurso() {
    const stmts = SCHEMA_SQLITE.split(';').map(s => s.trim()).filter(s => s.length > 10);
    for (const stmt of stmts) {
      await turso.execute(stmt).catch(e => {
        if (!e.message.includes('already exists')) console.warn('Turso schema warning:', e.message);
      });
    }
    console.log('✅ Turso schema ready');
  }

  const db = {
    _pg: false,
    _turso: true,
    init: initTurso,

    prepare(sql) {
      return {
        async get(...args) {
          const r = await turso.execute({ sql, args });
          return r.rows[0] ? Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0][i]])) : undefined;
        },
        async all(...args) {
          const r = await turso.execute({ sql, args });
          return r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
        },
        async run(...args) {
          const r = await turso.execute({ sql, args });
          return { lastInsertRowid: r.lastInsertRowid, changes: r.rowsAffected };
        },
      };
    },

    async exec(sql) {
      const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 5);
      for (const s of stmts) {
        await turso.execute(s).catch(() => {});
      }
    },
  };

  console.log('✅ Using Turso LibSQL (persistent cloud)');
  module.exports = db;

} else {
  // ── LOCAL FALLBACK (node-sqlite3-wasm) ──────────────────────────────
  const SCHEMA_SQLITE = `
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_job_asin ON amazon_leads(job_id, asin);
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

  const { Database } = require('node-sqlite3-wasm');
  const path = require('path');
  const fs = require('fs');

  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const _db = new Database(path.join(DATA_DIR, 'leadgen.db'));
  _db.exec(SCHEMA_SQLITE);

  console.log('⚠️  Using local SQLite (no DATABASE_URL set)');

  const db = {
    _pg: false,
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
