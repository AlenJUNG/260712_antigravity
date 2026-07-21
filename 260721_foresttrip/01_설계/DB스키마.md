# SQLite 스키마 초안 — 숲나들e 알림 앱 (Phase 0+1)

> 개인 규모 저장소. 카탈로그 캐시 · 세션/자격증명(암호화) · 감시 · 디바이스 ·
> **스캔 시계열 이력(append-only, ADR-0004)** · 알림 로그.
> 멀티유저 확장 시 Postgres로 이전(스키마 유지). 날짜 `YYYYMMDD` TEXT, 시각 ISO-8601 TEXT.

---

## 1. 카탈로그 캐시 (기존 catalog.js 결과 캐시)

```sql
CREATE TABLE forest (
  instt_id     TEXT PRIMARY KEY,        -- 휴양림 식별자 (insttId)
  name         TEXT NOT NULL,           -- (강릉시)대관령자연휴양림
  sido_code    TEXT NOT NULL,           -- 시/도 코드
  instt_tp_cd  TEXT,                    -- 01/02/04
  type         TEXT,                    -- 국립/공립/사립
  open_year    INTEGER,                 -- 국립만, 그 외 NULL
  is_new       INTEGER,                 -- 0/1, 국립만
  lat          REAL, lng REAL,          -- (선택) 표준데이터 좌표
  updated_at   TEXT NOT NULL
);

CREATE TABLE forest_calendar (
  instt_id  TEXT NOT NULL,
  date      TEXT NOT NULL,              -- YYYYMMDD
  kind      TEXT NOT NULL,              -- 선착순/추첨/휴무
  name      TEXT,                       -- "주말 추첨" 등
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instt_id, date)
);
```

---

## 2. 세션·자격증명 (ADR-0002, 개인 MVP는 단일 소유자)

```sql
-- 자격증명: 백엔드에만 암호화 저장. 평문 금지.
CREATE TABLE forest_credential (
  id             INTEGER PRIMARY KEY CHECK (id = 1),  -- 단일 행(MVP)
  login_id       TEXT NOT NULL,
  enc_password   BLOB NOT NULL,        -- 암호화된 비밀번호. Windows DPAPI(사용자 계정 바인딩) 권장(L1).
                                       -- 키를 같은 PC에 평문 저장 금지. 평문 로깅 금지.
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- 로그인 세션(storageState = auth.json 상당)
CREATE TABLE forest_session (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  storage_state  TEXT NOT NULL,        -- Playwright storageState JSON
  established_at TEXT NOT NULL,
  last_checked   TEXT,
  valid          INTEGER NOT NULL DEFAULT 1,
  needs_relogin  INTEGER NOT NULL DEFAULT 0
);
```
> 멀티유저 확장 시 두 테이블에 `owner_id` 추가 + 서비스계정 풀 테이블 신설.

---

## 3. 디바이스 (앱 사용자 = 푸시 대상)

```sql
CREATE TABLE device (
  device_id           TEXT PRIMARY KEY,   -- 앱 생성 UUID
  fcm_token           TEXT,
  platform            TEXT,               -- android
  dnd_start           TEXT,               -- "23:00"
  dnd_end             TEXT,               -- "07:00"
  urgent_bypass_dnd   INTEGER DEFAULT 1,
  notify_rank_improve INTEGER DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
```

---

## 4. 감시 (Watch)

```sql
CREATE TABLE watch (
  id            TEXT PRIMARY KEY,        -- W789
  device_id     TEXT NOT NULL REFERENCES device(device_id),
  type          TEXT NOT NULL,           -- room | forest
  instt_id      TEXT NOT NULL REFERENCES forest(instt_id),
  goods_id      TEXT,                    -- room 감시 시(백업: room_label)
  room_label    TEXT,
  nofpr         INTEGER NOT NULL,
  nights        INTEGER NOT NULL,
  date          TEXT,                    -- 단일 날짜 (또는 아래 범위)
  range_start   TEXT,                    -- 희망기간(Phase 2)
  range_end     TEXT,
  weekday_filter TEXT DEFAULT 'any',     -- any | weekday | weekend
  priority      TEXT NOT NULL DEFAULT 'normal',  -- normal | urgent
  notify_grades TEXT NOT NULL,           -- JSON 배열 '["예약가능","대기가능"]'
  wait_deadline TEXT,                    -- D-2 (대기감시 자동종료 기준)
  active        INTEGER NOT NULL DEFAULT 1,
  paused        INTEGER NOT NULL DEFAULT 0,
  -- 알림 중복 방지용 최신 상태 캐시
  last_status       TEXT,                -- 예약가능/대기가능/null
  last_wait_rank    TEXT,
  last_notified_state TEXT,
  last_notified_at  TEXT,
  last_checked_at   TEXT,
  created_at    TEXT NOT NULL,
  CHECK (date IS NOT NULL OR (range_start IS NOT NULL AND range_end IS NOT NULL))
);
CREATE INDEX idx_watch_active ON watch(active, paused);
CREATE INDEX idx_watch_target ON watch(instt_id, date);
```

---

## 5. 스캔 시계열 이력 (ADR-0004, append-only)

```sql
-- 한 번의 (휴양림,날짜,인원) 조회 실행
CREATE TABLE scan (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instt_id    TEXT NOT NULL,
  date        TEXT NOT NULL,            -- 체크인 YYYYMMDD
  nofpr       INTEGER NOT NULL,
  nights      INTEGER NOT NULL,
  scanned_at  TEXT NOT NULL,
  source      TEXT NOT NULL,           -- snapshot | ondemand | watch
  ok          INTEGER NOT NULL         -- NetFunnel/로그인 통과 여부.
                                       -- 연속 실패·성공률 하락 = 소프트밴/세션사망 신호 → 소유자 푸시(M5)
);
CREATE INDEX idx_scan_target_time ON scan(instt_id, date, scanned_at);

-- 스캔 시점의 방 단위 상태(시계열의 핵심). goods.extractRooms() 결과 1행=1방.
CREATE TABLE room_state (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id     INTEGER NOT NULL REFERENCES scan(id),
  instt_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  goods_id    TEXT,
  room_label  TEXT,                     -- detail
  facility    TEXT,                     -- 휴양관/숲속의집
  capacity    TEXT, price TEXT,
  status      TEXT,                     -- 예약가능/대기가능/null
  reservable  INTEGER, waitable INTEGER,
  wait_rank   TEXT,
  scanned_at  TEXT NOT NULL             -- scan.scanned_at 비정규화(조회 편의)
);
CREATE INDEX idx_room_state_key ON room_state(instt_id, date, goods_id, scanned_at);

-- 휴양림 단위 스냅샷(전국 조회 즉시응답용). availability.searchRegionAvailability 결과.
CREATE TABLE forest_availability (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instt_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  nofpr       INTEGER NOT NULL,
  status      TEXT,                     -- 예약가능/예약불가
  reservable  INTEGER,
  room_count  INTEGER,
  scanned_at  TEXT NOT NULL
);
CREATE INDEX idx_forest_avail_key ON forest_availability(date, nofpr, scanned_at);

-- 상태 전이(파생): 감시/타임라인/학습용. room_state 연속행 비교로 생성.
CREATE TABLE watch_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instt_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  goods_id    TEXT,
  event_type  TEXT NOT NULL,            -- opened | closed | rank_changed
  from_state  TEXT, to_state TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_watch_event_key ON watch_event(instt_id, date, goods_id, occurred_at);
```

> **보존/롤업:** `room_state`·`forest_availability`는 무한 증가 → 예: 원시 90일 후 시간대별
> 집계로 다운샘플(명당시간 학습은 집계로 충분). `watch_event`는 오래 보존(타임라인/학습).

---

## 6. 알림 로그 (중복 방지 + 감사)

```sql
CREATE TABLE notification (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id    TEXT NOT NULL REFERENCES watch(id),
  device_id   TEXT NOT NULL,
  grade       TEXT NOT NULL,            -- 예약가능(긴급)/대기가능(일반)/순위개선
  state       TEXT NOT NULL,            -- 알림 시점 상태
  date        TEXT,                     -- 어느 체크인 날짜에 대한 알림(희망기간 대응)
  goods_id    TEXT,
  sent_at     TEXT NOT NULL,
  payload     TEXT                      -- 딥링크 등 JSON
);
CREATE INDEX idx_notif_watch ON notification(watch_id, sent_at);
```
- 재알림 스로틀: 동일 (watch_id, goods_id, state)에 대해 최근 알림 시각을 조회해 X분 내 억제.

---

## 7. 폴링 스케줄 상태 (레이트버짓·적응형)

```sql
-- 폴링 대상 큐: 감시에서 파생된 (휴양림,날짜,인원) 단위(중복 병합)
CREATE TABLE poll_target (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instt_id      TEXT NOT NULL,
  date          TEXT NOT NULL,
  nofpr         INTEGER NOT NULL,
  nights        INTEGER NOT NULL,
  next_due_at   TEXT NOT NULL,          -- 적응형 다음 폴링 예정
  interval_sec  INTEGER NOT NULL,       -- 현재 주기(임박·취소多 시 축소)
  priority      TEXT NOT NULL DEFAULT 'normal',
  last_polled_at TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (instt_id, date, nofpr, nights)
);
CREATE INDEX idx_poll_due ON poll_target(active, next_due_at);
```
- 전역 레이트버짓: 스케줄러가 단위시간 요청수 상한(`R` req/min, ADR-0006)을 두고 `next_due_at` 순으로 소비.
- **파생·GC(reconciliation, M3):** `poll_target`은 활성 `watch`에서 (instt_id,date,nofpr,nights)로
  파생·병합된다. 감시 삭제·일시정지·날짜경과·D-2 종료로 **어느 감시도 참조하지 않는 target**은
  주기적 reconciliation으로 비활성/삭제한다(refcount 컬럼 없이 재파생으로 판정). 고아 target이
  레이트버짓을 소모하지 않게 함.
- **커버리지 상한(ADR-0006):** 활성 `poll_target` 수가 예산 기반 `N_max`에 근접하면 API가 커버리지
  저하를 표면화한다. min-nofpr 병합이 성립하면 인원 변형을 한 target으로 합쳐 상한을 크게 회복한다.
