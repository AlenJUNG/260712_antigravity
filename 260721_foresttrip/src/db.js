import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";

// Ensure data folder exists
const dbPath = "data/forest.db";
const dir = dirname(dbPath);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

export const db = new DatabaseSync(dbPath);

// Initialize DB schema
export function initDb() {
  // 1. forest table
  db.exec(`
    CREATE TABLE IF NOT EXISTS forest (
      instt_id     TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      sido_code    TEXT NOT NULL,
      instt_tp_cd  TEXT,
      type         TEXT,
      open_year    INTEGER,
      is_new       INTEGER,
      lat          REAL,
      lng          REAL,
      updated_at   TEXT NOT NULL
    );
  `);

  // 2. forest_calendar table
  db.exec(`
    CREATE TABLE IF NOT EXISTS forest_calendar (
      instt_id  TEXT NOT NULL,
      date      TEXT NOT NULL,
      kind      TEXT NOT NULL,
      name      TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instt_id, date)
    );
  `);

  // 3. forest_credential table
  db.exec(`
    CREATE TABLE IF NOT EXISTS forest_credential (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      login_id       TEXT NOT NULL,
      enc_password   TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
  `);

  // 4. forest_session table
  db.exec(`
    CREATE TABLE IF NOT EXISTS forest_session (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      storage_state  TEXT NOT NULL,
      established_at TEXT NOT NULL,
      last_checked   TEXT,
      valid          INTEGER NOT NULL DEFAULT 1,
      needs_relogin  INTEGER NOT NULL DEFAULT 0
    );
  `);

  // 5. device table
  db.exec(`
    CREATE TABLE IF NOT EXISTS device (
      device_id           TEXT PRIMARY KEY,
      fcm_token           TEXT,
      platform            TEXT,
      dnd_start           TEXT,
      dnd_end             TEXT,
      urgent_bypass_dnd   INTEGER DEFAULT 1,
      notify_rank_improve INTEGER DEFAULT 0,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
  `);

  // 6. watch table
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch (
      id            TEXT PRIMARY KEY,
      device_id     TEXT NOT NULL REFERENCES device(device_id),
      type          TEXT NOT NULL,
      instt_id      TEXT NOT NULL REFERENCES forest(instt_id),
      goods_id      TEXT,
      room_label    TEXT,
      nofpr         INTEGER NOT NULL,
      nights        INTEGER NOT NULL,
      date          TEXT,
      range_start   TEXT,
      range_end     TEXT,
      weekday_filter TEXT DEFAULT 'any',
      priority      TEXT NOT NULL DEFAULT 'normal',
      notify_grades TEXT NOT NULL,
      wait_deadline TEXT,
      active        INTEGER NOT NULL DEFAULT 1,
      paused        INTEGER NOT NULL DEFAULT 0,
      last_status       TEXT,
      last_wait_rank    TEXT,
      last_notified_state TEXT,
      last_notified_at  TEXT,
      last_checked_at   TEXT,
      created_at    TEXT NOT NULL,
      CHECK (date IS NOT NULL OR (range_start IS NOT NULL AND range_end IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_watch_active ON watch(active, paused);
    CREATE INDEX IF NOT EXISTS idx_watch_target ON watch(instt_id, date);
  `);

  // 7. scan table
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instt_id    TEXT NOT NULL,
      date        TEXT NOT NULL,
      nofpr       INTEGER NOT NULL,
      nights      INTEGER NOT NULL,
      scanned_at  TEXT NOT NULL,
      source      TEXT NOT NULL,
      ok          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scan_target_time ON scan(instt_id, date, scanned_at);
  `);

  // 8. room_state table
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_state (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id     INTEGER NOT NULL REFERENCES scan(id),
      instt_id    TEXT NOT NULL,
      date        TEXT NOT NULL,
      goods_id    TEXT,
      room_label  TEXT,
      facility    TEXT,
      capacity    TEXT,
      price       TEXT,
      status      TEXT,
      reservable  INTEGER,
      waitable    INTEGER,
      wait_rank   TEXT,
      scanned_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_room_state_key ON room_state(instt_id, date, goods_id, scanned_at);
  `);

  // 9. forest_availability table
  db.exec(`
    CREATE TABLE IF NOT EXISTS forest_availability (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instt_id    TEXT NOT NULL,
      date        TEXT NOT NULL,
      nofpr       INTEGER NOT NULL,
      status      TEXT,
      reservable  INTEGER,
      room_count  INTEGER,
      scanned_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_forest_avail_key ON forest_availability(date, nofpr, scanned_at);
  `);

  // 10. watch_event table
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_event (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instt_id    TEXT NOT NULL,
      date        TEXT NOT NULL,
      goods_id    TEXT,
      event_type  TEXT NOT NULL,
      from_state  TEXT,
      to_state    TEXT,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watch_event_key ON watch_event(instt_id, date, goods_id, occurred_at);
  `);

  // 11. notification table
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id    TEXT NOT NULL REFERENCES watch(id),
      device_id   TEXT NOT NULL,
      grade       TEXT NOT NULL,
      state       TEXT NOT NULL,
      date        TEXT,
      goods_id    TEXT,
      sent_at     TEXT NOT NULL,
      payload     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notif_watch ON notification(watch_id, sent_at);
  `);

  // 12. poll_target table
  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_target (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      instt_id      TEXT NOT NULL,
      date          TEXT NOT NULL,
      nofpr         INTEGER NOT NULL,
      nights        INTEGER NOT NULL,
      next_due_at   TEXT NOT NULL,
      interval_sec  INTEGER NOT NULL,
      priority      TEXT NOT NULL DEFAULT 'normal',
      last_polled_at TEXT,
      active        INTEGER NOT NULL DEFAULT 1,
      UNIQUE (instt_id, date, nofpr, nights)
    );
    CREATE INDEX IF NOT EXISTS idx_poll_due ON poll_target(active, next_due_at);
  `);
}

// Cryptography Helpers for password encryption
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "森林trip_secure_enc_key_2026_default";
const KEY = crypto.scryptSync(ENCRYPTION_KEY, 'salt-salt-salt', 32);

export function encryptPassword(password) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ iv: iv.toString('hex'), encrypted, authTag });
}

export function decryptPassword(encText) {
  try {
    const { iv, encrypted, authTag } = JSON.parse(encText);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}
