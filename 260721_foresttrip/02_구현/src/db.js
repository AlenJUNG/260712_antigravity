import "./env.js";   // 반드시 첫 임포트 — ENCRYPTION_KEY 를 모듈 스코프에서 읽는다
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// DB 경로는 프로젝트 루트 기준으로 고정한다. 상대경로("data/forest.db")로 두면
// 실행 디렉터리에 따라 빈 DB가 새로 생겨 감시가 통째로 사라진다.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.DB_PATH || join(ROOT, "data", "forest.db");
const dir = dirname(dbPath);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");

/** 기존 DB에 없는 컬럼만 추가한다(마이그레이션 최소 대체). */
function addColumnIfMissing(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

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
  // 달력 메타(휴양림별 최대 숙박일수/예약주기). DB스키마.md 초안 이후 추가된 컬럼이라
  // 기존 DB에도 적용되도록 ALTER 로 보강한다. (하드코딩 maxNights=3 제거용)
  addColumnIfMissing("forest", "max_nights", "INTEGER");
  addColumnIfMissing("forest", "cycle_type", "TEXT");

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

// ── 자격증명 암호화 (ADR-0002 / DB스키마 §2) ────────────────────────────────
//
// 키를 소스에 기본값으로 박아두면 리포지토리 + forest.db 만으로 누구나 복호화할 수
// 있어 암호화가 장식이 된다. 키가 없으면 **기동을 거부**한다.
// 운영 권장: Windows DPAPI(사용자 계정 바인딩)로 보호한 값을 프로세스 환경으로 주입.
// 같은 PC에 평문 키 파일을 두지 말 것.

const RAW_KEY = process.env.ENCRYPTION_KEY;
if (!RAW_KEY || RAW_KEY.length < 16) {
  throw new Error(
    "ENCRYPTION_KEY 환경변수가 없거나 너무 짧습니다(16자 이상 필요).\n" +
    "  숲나들e 비밀번호를 암호화해 저장하는 키입니다. 기본값은 제공하지 않습니다.\n" +
    "  생성 예: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
    "  키를 분실하면 저장된 자격증명은 복호화 불가 → /v1/auth/forest-login 으로 재등록하세요."
  );
}
// salt 도 키에서 파생시켜 배포마다 달라지게 한다(고정 salt 'salt-salt-salt' 제거).
const SALT = crypto.createHash("sha256").update(`foresttrip:kdf:${RAW_KEY}`).digest();
const KEY = crypto.scryptSync(RAW_KEY, SALT, 32);

export function encryptPassword(password) {
  const iv = crypto.randomBytes(12); // GCM 표준 nonce 길이
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ v: 2, iv: iv.toString('hex'), encrypted, authTag });
}

export function decryptPassword(encText) {
  try {
    const { iv, encrypted, authTag } = JSON.parse(encText);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null; // 키 교체·손상 시 null → 호출부가 재로그인 유도
  }
}
