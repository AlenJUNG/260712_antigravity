import "./env.js";   // 반드시 첫 임포트 (APP_TOKEN/ENCRYPTION_KEY 를 모듈 스코프에서 읽는다)
import http from "node:http";
import crypto from "node:crypto";
import { openSession } from "./session.js";
import { getSidoList, getFacilityCalendar } from "./catalog.js";
import { searchForestGoods } from "./goods.js";
import { initDb, db, encryptPassword } from "./db.js";
import { populateForests } from "./db_populate.js";
import { getSessionContext, validateSession } from "./session_manager.js";
import {
  reconcilePollTargets, schedulerTick, coverageState,
  enqueueAvailabilityRefresh, isRefreshQueued, getAvailabilityJob, resetForestNameIndex,
} from "./scheduler.js";
import { ingestScan } from "./transitions.js";
import { tryConsume, GOODS_POLL_COST, settle } from "./rateBudget.js";
import { todayYmd, addDays, isYmd, nowIso } from "./dates.js";

const PORT = Number(process.env.PORT || 3000);

// ── 인증 (ADR-0005) ────────────────────────────────────────────────────────
// 백엔드는 터널로 인터넷에 노출되는 것이 전제다. 기본 토큰을 두면 무인증과 다를 바 없어
// 누구나 단일 숲나들e 계정을 조종할 수 있다. 토큰이 없으면 기동을 거부한다.
const APP_TOKEN = process.env.APP_TOKEN;
if (!APP_TOKEN || APP_TOKEN.length < 24) {
  console.error(
    "APP_TOKEN 환경변수가 없거나 너무 짧습니다(24자 이상 필요).\n" +
    "  앱↔백엔드 Bearer 토큰입니다. 기본값은 제공하지 않습니다.\n" +
    "  생성 예: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
  );
  process.exit(1);
}
const APP_TOKEN_BUF = Buffer.from(`Bearer ${APP_TOKEN}`, "utf8");

function isAuthorized(req) {
  const header = req.headers["authorization"];
  if (!header) return false;
  const given = Buffer.from(header, "utf8");
  if (given.length !== APP_TOKEN_BUF.length) return false;
  return crypto.timingSafeEqual(given, APP_TOKEN_BUF);
}

/** 스냅샷이 이 시간(초)보다 오래되면 갱신 잡을 큐잉한다. */
const AVAIL_TTL_SEC = Number(process.env.AVAIL_TTL_SEC || 600);

// ── 기동 ───────────────────────────────────────────────────────────────────
initDb();
populateForests();
resetForestNameIndex();
reconcilePollTargets();

// 스케줄러 루프. schedulerTick 내부에 재진입 가드가 있어 겹쳐 돌지 않는다.
setInterval(() => {
  schedulerTick().catch((err) => console.error("스케줄러 틱 오류:", err));
}, 5000);

setInterval(() => {
  try { reconcilePollTargets(); } catch (err) { console.error("주기 reconciliation 오류:", err); }
}, 10 * 60 * 1000);

// ── 라우팅 ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 프로세스 생존 확인용 최소 공개 엔드포인트(세션 정보 노출 없음)
  if (url.pathname === "/health") return json(res, 200, { ok: true });

  // API계약 §0: 모든 /v1/* 은 Bearer 필수. 무인증 fallback 없음.
  if (!isAuthorized(req)) {
    return json(res, 401, { error: { code: "UNAUTHORIZED", message: "Bearer 토큰이 없거나 유효하지 않습니다." } });
  }

  try {
    if (url.pathname === "/v1/health" && req.method === "GET") {
      const session = db.prepare(`SELECT * FROM forest_session WHERE id = 1`).get();
      return json(res, 200, {
        ok: true,
        session: {
          loggedIn: !!session,
          valid: session ? !!session.valid : false,
          needsRelogin: session ? !!session.needs_relogin : false,
          lastLoginAt: session ? session.established_at : null,
        },
        // ADR-0006 §2: 커버리지 상한을 1급 제약으로 노출한다.
        coverage: coverageState(),
      });
    }

    if (url.pathname === "/v1/sido" && req.method === "GET") {
      const session = await openSession();
      return json(res, 200, await getSidoList(session));
    }

    if (url.pathname === "/v1/forests" && req.method === "GET") {
      const sido = url.searchParams.get("sido");
      const rows = sido
        ? db.prepare(`SELECT * FROM forest WHERE sido_code = ? ORDER BY name`).all(sido)
        : db.prepare(`SELECT * FROM forest ORDER BY sido_code, name`).all();
      return json(res, 200, rows.map(serializeForest));
    }

    const calendarMatch = url.pathname.match(/^\/v1\/forests\/([^/]+)\/calendar$/);
    if (calendarMatch && req.method === "GET") {
      return json(res, 200, await getCalendar(calendarMatch[1]));
    }

    if (url.pathname === "/v1/auth/forest-login") {
      if (req.method === "POST") return await handleForestLogin(req, res);
      if (req.method === "DELETE") {
        db.prepare(`DELETE FROM forest_credential WHERE id = 1`).run();
        db.prepare(`DELETE FROM forest_session WHERE id = 1`).run();
        return json(res, 200, { success: true });
      }
    }

    if (url.pathname === "/v1/auth/status" && req.method === "GET") {
      const session = db.prepare(`SELECT * FROM forest_session WHERE id = 1`).get();
      return json(res, 200, {
        loggedIn: !!session,
        valid: session ? !!session.valid : false,
        lastLoginAt: session ? session.established_at : null,
        needsRelogin: session ? !!session.needs_relogin : false,
      });
    }

    if (url.pathname === "/v1/devices" && req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body.deviceId) return badRequest(res, "deviceId 는 필수입니다.");
      const now = nowIso();
      db.prepare(`
        INSERT INTO device (device_id, fcm_token, platform, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          fcm_token = excluded.fcm_token, platform = excluded.platform, updated_at = excluded.updated_at
      `).run(body.deviceId, body.fcmToken || null, body.platform || "android", now, now);
      return json(res, 200, { deviceId: body.deviceId });
    }

    const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
    if (deviceMatch && req.method === "PATCH") {
      const body = await parseJsonBody(req);
      const cur = db.prepare(`SELECT * FROM device WHERE device_id = ?`).get(deviceMatch[1]);
      if (!cur) return json(res, 404, { error: { code: "NOT_FOUND", message: "device 를 찾을 수 없습니다." } });
      db.prepare(`
        UPDATE device SET dnd_start = ?, dnd_end = ?, urgent_bypass_dnd = ?, notify_rank_improve = ?, updated_at = ?
        WHERE device_id = ?
      `).run(
        body.dndStart !== undefined ? body.dndStart : cur.dnd_start,
        body.dndEnd !== undefined ? body.dndEnd : cur.dnd_end,
        body.urgentBypassDnd !== undefined ? (body.urgentBypassDnd ? 1 : 0) : cur.urgent_bypass_dnd,
        body.notifyRankImprove !== undefined ? (body.notifyRankImprove ? 1 : 0) : cur.notify_rank_improve,
        nowIso(), deviceMatch[1]
      );
      const after = db.prepare(`SELECT * FROM device WHERE device_id = ?`).get(deviceMatch[1]);
      return json(res, 200, {
        deviceId: after.device_id,
        dndStart: after.dnd_start, dndEnd: after.dnd_end,
        urgentBypassDnd: !!after.urgent_bypass_dnd,
        notifyRankImprove: !!after.notify_rank_improve,
      });
    }

    if (url.pathname === "/v1/watches") {
      if (req.method === "GET") {
        const deviceId = url.searchParams.get("deviceId");
        if (!deviceId) return badRequest(res, "deviceId 는 필수입니다.");
        const rows = db.prepare(`SELECT * FROM watch WHERE device_id = ? ORDER BY date, created_at`).all(deviceId);
        return json(res, 200, rows.map((w) => serializeWatch(w)));
      }
      if (req.method === "POST") return await handleCreateWatch(req, res);
    }

    const watchEventsMatch = url.pathname.match(/^\/v1\/watches\/([^/]+)\/events$/);
    if (watchEventsMatch && req.method === "GET") {
      const w = db.prepare(`SELECT * FROM watch WHERE id = ?`).get(watchEventsMatch[1]);
      if (!w) return json(res, 404, { error: { code: "NOT_FOUND", message: "watch 를 찾을 수 없습니다." } });
      return json(res, 200, watchEvents(w, 200));
    }

    const watchMatch = url.pathname.match(/^\/v1\/watches\/([^/]+)$/);
    if (watchMatch) {
      const id = watchMatch[1];
      const w = db.prepare(`SELECT * FROM watch WHERE id = ?`).get(id);
      if (!w) return json(res, 404, { error: { code: "NOT_FOUND", message: "watch 를 찾을 수 없습니다." } });

      if (req.method === "GET") return json(res, 200, serializeWatch(w, { includeEvents: true }));

      if (req.method === "PATCH") {
        const body = await parseJsonBody(req);
        const sets = [], params = [];
        if (body.paused !== undefined) { sets.push("paused = ?"); params.push(body.paused ? 1 : 0); }
        if (body.active !== undefined) { sets.push("active = ?"); params.push(body.active ? 1 : 0); }
        if (body.priority !== undefined) {
          if (!["normal", "urgent"].includes(body.priority)) return badRequest(res, "priority 는 normal|urgent 입니다.");
          sets.push("priority = ?"); params.push(body.priority);
        }
        if (body.notifyGrades !== undefined) {
          const bad = !Array.isArray(body.notifyGrades) || body.notifyGrades.some((g) => !["예약가능", "대기가능"].includes(g));
          if (bad) return badRequest(res, "notifyGrades 는 [\"예약가능\",\"대기가능\"] 의 부분집합이어야 합니다.");
          sets.push("notify_grades = ?"); params.push(JSON.stringify(body.notifyGrades));
        }
        if (sets.length > 0) {
          params.push(id);
          db.prepare(`UPDATE watch SET ${sets.join(", ")} WHERE id = ?`).run(...params);
          reconcilePollTargets();
        }
        return json(res, 200, serializeWatch(db.prepare(`SELECT * FROM watch WHERE id = ?`).get(id)));
      }

      if (req.method === "DELETE") {
        db.prepare(`DELETE FROM notification WHERE watch_id = ?`).run(id);
        db.prepare(`DELETE FROM watch WHERE id = ?`).run(id);
        reconcilePollTargets();
        return json(res, 200, { success: true });
      }
    }

    if (url.pathname === "/v1/search" && req.method === "GET") return handleSearch(url, res);

    if (url.pathname === "/v1/search/refresh" && req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!isYmd(body.date)) return badRequest(res, "date (YYYYMMDD) 는 필수입니다.");
      const jobId = enqueueAvailabilityRefresh({
        sido: body.sido, date: body.date,
        nights: Number(body.nights || 1), nofpr: Number(body.nofpr || 2),
      });
      return json(res, 202, { jobId });
    }

    const jobMatch = url.pathname.match(/^\/v1\/search\/refresh\/([^/]+)$/);
    if (jobMatch && req.method === "GET") {
      const job = getAvailabilityJob(jobMatch[1]);
      if (!job) return json(res, 404, { error: { code: "NOT_FOUND", message: "job 을 찾을 수 없습니다." } });
      return json(res, 200, {
        jobId: job.id, status: job.status, queuedAt: job.queuedAt,
        finishedAt: job.finishedAt ?? null, remaining: job.pending.length,
      });
    }

    const roomsMatch = url.pathname.match(/^\/v1\/forests\/([^/]+)\/rooms$/);
    if (roomsMatch && req.method === "GET") return await handleRooms(roomsMatch[1], url, res);

    return json(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
  } catch (e) {
    console.error("요청 처리 오류:", e);
    return json(res, 500, { error: { code: "INTERNAL", message: String(e?.message || e) } });
  }
});

// ── 핸들러 ─────────────────────────────────────────────────────────────────

async function handleForestLogin(req, res) {
  const body = await parseJsonBody(req);
  if (!body.loginId || !body.loginPwd) return badRequest(res, "loginId 와 loginPwd 는 필수입니다.");

  const prevCred = db.prepare(`SELECT * FROM forest_credential WHERE id = 1`).get();
  const now = nowIso();
  db.prepare(`
    INSERT INTO forest_credential (id, login_id, enc_password, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      login_id = excluded.login_id, enc_password = excluded.enc_password, updated_at = excluded.updated_at
  `).run(body.loginId, encryptPassword(body.loginPwd), now, now);
  // 새 자격증명이 들어왔으므로 재로그인 차단 플래그를 푼다.
  db.prepare(`DELETE FROM forest_session WHERE id = 1`).run();

  let ctx = null;
  try {
    ctx = await getSessionContext();       // 여기서 실제 로그인 1회 수행
    const valid = await validateSession(ctx);
    if (valid) return json(res, 200, { loggedIn: true, valid: true, lastLoginAt: now });
    throw new Error("로그인 후에도 로그인 상태가 확인되지 않았습니다.");
  } catch (err) {
    // 실패 시 이전 자격증명으로 되돌린다(새 값으로 덮어써 놓고 실패하면 복구 불가해진다).
    if (prevCred) {
      db.prepare(`
        INSERT INTO forest_credential (id, login_id, enc_password, created_at, updated_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          login_id = excluded.login_id, enc_password = excluded.enc_password, updated_at = excluded.updated_at
      `).run(prevCred.login_id, prevCred.enc_password, prevCred.created_at, now);
    } else {
      db.prepare(`DELETE FROM forest_credential WHERE id = 1`).run();
    }
    // 비밀번호 5회 오류 = 계정 잠금. 클라이언트는 재시도를 신중히 해야 한다.
    return json(res, 401, { error: { code: "LOGIN_FAILED", message: err.message } });
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function handleCreateWatch(req, res) {
  const body = await parseJsonBody(req);
  if (!body.deviceId || !body.type || !body.insttId) {
    return badRequest(res, "deviceId, type, insttId 는 필수입니다.");
  }
  if (!["room", "forest"].includes(body.type)) return badRequest(res, "type 은 room|forest 입니다.");
  if (body.type === "room" && !body.goodsId) return badRequest(res, "room 감시는 goodsId 가 필수입니다.");
  if (!isYmd(body.date)) return badRequest(res, "date (YYYYMMDD) 는 필수입니다. 희망기간(rangeStart/End)은 Phase 2입니다.");
  if (body.date < todayYmd()) return badRequest(res, "지난 날짜는 감시할 수 없습니다.");
  if (!db.prepare(`SELECT 1 FROM device WHERE device_id = ?`).get(body.deviceId)) {
    return badRequest(res, "등록되지 않은 deviceId 입니다. 먼저 POST /v1/devices 로 등록하세요.");
  }
  if (!db.prepare(`SELECT 1 FROM forest WHERE instt_id = ?`).get(body.insttId)) {
    return badRequest(res, "알 수 없는 insttId 입니다.");
  }
  const grades = Array.isArray(body.notifyGrades) && body.notifyGrades.length ? body.notifyGrades : ["예약가능"];
  if (grades.some((g) => !["예약가능", "대기가능"].includes(g))) {
    return badRequest(res, "notifyGrades 는 [\"예약가능\",\"대기가능\"] 의 부분집합이어야 합니다.");
  }

  const id = newWatchId();
  db.prepare(`
    INSERT INTO watch (id, device_id, type, instt_id, goods_id, room_label, nofpr, nights, date,
                       weekday_filter, priority, notify_grades, wait_deadline, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, body.deviceId, body.type, body.insttId,
    body.goodsId || null, body.roomLabel || null,
    Number(body.nofpr || 2), Number(body.nights || 1), body.date,
    body.weekdayFilter || "any",
    ["normal", "urgent"].includes(body.priority) ? body.priority : "normal",
    JSON.stringify(grades),
    addDays(body.date, -2),      // 대기신청 마감 = 숙박일 D-2
    nowIso()
  );

  reconcilePollTargets();
  return json(res, 201, serializeWatch(db.prepare(`SELECT * FROM watch WHERE id = ?`).get(id)));
}

/**
 * 스냅샷 기반 조회 (ADR-0003).
 *
 * 요청 스레드에서 라이브 스크래핑을 하지 않는다 — 예전엔 매 요청 NetFunnel 조회를
 * 동기로 돌렸고, sido 가 없으면 강원("2")만 긁고는 전국 결과인 척 응답했다.
 * 지금은 DB 스냅샷만 즉시 반환하고, 오래됐으면 백그라운드 갱신을 큐잉한다.
 */
function handleSearch(url, res) {
  const date = url.searchParams.get("date");
  const nights = Number(url.searchParams.get("nights") || 1);
  const nofpr = Number(url.searchParams.get("nofpr") || 2);
  const sido = url.searchParams.get("sido");
  if (!isYmd(date)) return badRequest(res, "date (YYYYMMDD) 는 필수입니다.");

  const forests = sido
    ? db.prepare(`SELECT * FROM forest WHERE sido_code = ? ORDER BY name`).all(sido)
    : db.prepare(`SELECT * FROM forest ORDER BY sido_code, name`).all();

  const availStmt = db.prepare(`
    SELECT status, reservable, room_count, scanned_at FROM forest_availability
    WHERE instt_id = ? AND date = ? AND nofpr = ?
    ORDER BY scanned_at DESC LIMIT 1
  `);
  const watchedStmt = db.prepare(`
    SELECT 1 FROM watch WHERE instt_id = ? AND date = ? AND active = 1 AND paused = 0 LIMIT 1
  `);
  const lastScanStmt = db.prepare(`
    SELECT id, scanned_at FROM scan
    WHERE instt_id = ? AND date = ? AND nofpr = ? AND ok = 1 ORDER BY scanned_at DESC LIMIT 1
  `);
  const waitCountStmt = db.prepare(`
    SELECT
      sum(CASE WHEN status = '대기가능' THEN 1 ELSE 0 END) AS waitable,
      sum(CASE WHEN status = '예약가능' THEN 1 ELSE 0 END) AS reservable,
      count(*) AS total
    FROM room_state WHERE scan_id = ?
  `);
  const calStmt = db.prepare(`SELECT kind FROM forest_calendar WHERE instt_id = ? AND date = ?`);

  const staleBefore = Date.now() - AVAIL_TTL_SEC * 1000;
  let oldestAvail = null, oldestWait = null, availStale = false;
  const kindCount = new Map();

  const out = forests.map((f) => {
    const avail = availStmt.get(f.instt_id, date, nofpr);
    if (!avail || new Date(avail.scanned_at).getTime() < staleBefore) availStale = true;
    if (avail && (!oldestAvail || avail.scanned_at < oldestAvail)) oldestAvail = avail.scanned_at;

    // 대기가능은 방 단위·로그인·고비용이라 감시된 target 만 warm 하다 (ADR-0003/0006, H3).
    const covered = !!watchedStmt.get(f.instt_id, date);
    const lastScan = covered ? lastScanStmt.get(f.instt_id, date, nofpr) : null;
    let waitable = null, waitableRooms = null, reservableRooms = null;
    let roomCount = avail?.room_count ?? null;
    if (lastScan) {
      // 방 단위 수치는 실제 스캔에서만 나온다(예전엔 4/36 을 하드코딩해 응답했다).
      const c = waitCountStmt.get(lastScan.id);
      waitableRooms = c?.waitable ?? 0;
      reservableRooms = c?.reservable ?? 0;
      waitable = waitableRooms > 0;
      roomCount = c?.total ?? roomCount;
      if (!oldestWait || lastScan.scanned_at < oldestWait) oldestWait = lastScan.scanned_at;
    }

    const dayKind = calStmt.get(f.instt_id, date)?.kind || "선착순";
    kindCount.set(dayKind, (kindCount.get(dayKind) || 0) + 1);

    return {
      insttId: f.instt_id,
      name: f.name,
      type: f.type,
      openYear: f.open_year,
      isNew: !!f.is_new,
      dayKind,                                   // 휴무·추첨은 휴양림마다 다르므로 개별로 준다
      reservable: avail ? avail.reservable === 1 : null,
      reservableRooms,                           // 스캔이 없으면 null(추정치를 지어내지 않는다)
      roomCount,
      waitable,
      waitableRooms,
      waitCovered: covered,
      waitSnapshotAt: lastScan ? lastScan.scanned_at : null,
      availSnapshotAt: avail ? avail.scanned_at : null,
    };
  });

  // 스냅샷이 없거나 오래됐으면 백그라운드 갱신을 큐잉하고 refreshing 으로 알린다.
  const refreshingAvail = availStale;
  if (availStale && !isRefreshQueued({ sido, date, nofpr })) {
    enqueueAvailabilityRefresh({ sido: sido || undefined, date, nights, nofpr });
  }

  const topKind = [...kindCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "선착순";
  return json(res, 200, {
    date, nights, nofpr, sido: sido || null,
    availSnapshotAt: oldestAvail,                // 포함된 스냅샷 중 가장 오래된 시각(보수적)
    waitSnapshotAt: oldestWait,                  // 감시 커버된 휴양림이 없으면 null
    refreshing: { avail: refreshingAvail, wait: false },
    dayKind: topKind,
    coverage: coverageState(),
    forests: out,
  });
}

async function handleRooms(insttId, url, res) {
  const date = url.searchParams.get("date");
  const nights = Number(url.searchParams.get("nights") || 1);
  const nofpr = Number(url.searchParams.get("nofpr") || 2);
  if (!isYmd(date)) return badRequest(res, "date (YYYYMMDD) 는 필수입니다.");

  const forest = db.prepare(`SELECT name, sido_code FROM forest WHERE instt_id = ?`).get(insttId);
  if (!forest) return json(res, 404, { error: { code: "NOT_FOUND", message: "알 수 없는 insttId 입니다." } });

  // 온디맨드도 단일 계정을 쓰므로 동일한 전역 예산을 통과해야 한다 (ADR-0006).
  if (!tryConsume(GOODS_POLL_COST)) {
    res.setHeader("Retry-After", "60");
    return json(res, 429, {
      error: { code: "RATE_BUDGET_EXHAUSTED", message: "조회 예산을 초과했습니다. 잠시 후 다시 시도하세요." },
    });
  }

  let ctx = null;
  try {
    ctx = await getSessionContext();
    const result = await searchForestGoods({
      sido: forest.sido_code, insttId, checkin: date, checkout: addDays(date, nights),
      nofpr, context: ctx, includeWait: true,
    });
    settle(GOODS_POLL_COST, (result.pagesTraversed || 2) + 1);

    if (result.needLogin) {
      return json(res, 503, { error: { code: "SESSION_EXPIRED", message: "숲나들e 세션이 만료됐습니다. 재로그인이 필요합니다." } });
    }
    if (!result.ok) {
      return json(res, 502, { error: { code: "FETCH_FAILED", message: "goods 페이지에 도달하지 못했습니다." } });
    }

    const { scanId } = await ingestScan({
      insttId, date, nofpr, nights, source: "ondemand", rooms: result.rooms,
    });
    const scannedAt = db.prepare(`SELECT scanned_at FROM scan WHERE id = ?`).get(scanId).scanned_at;

    return json(res, 200, {
      insttId, date, nights, nofpr,
      fetchedAt: scannedAt,
      pagesTraversed: result.pagesTraversed ?? null,
      complete: !!result.complete,
      rooms: result.rooms.map((r) => ({
        goodsId: r.goodsId, facility: r.facility, detail: r.detail,
        capacity: r.capacity, price: r.price,
        status: r.status, reservable: !!r.available, waitable: !!r.waitable,
        waitRank: r.waitRank ?? null,
      })),
    });
  } catch (err) {
    console.error("온디맨드 조회 실패:", err.message);
    return json(res, 502, { error: { code: "FETCH_FAILED", message: err.message } });
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function getCalendar(insttId) {
  const forest = db.prepare(`SELECT max_nights, cycle_type FROM forest WHERE instt_id = ?`).get(insttId);
  const today = todayYmd();
  let dates = db.prepare(`
    SELECT date, kind, name FROM forest_calendar
    WHERE instt_id = ? AND date >= ? ORDER BY date
  `).all(insttId, today);

  let maxNights = forest?.max_nights ?? null;
  let cycleType = forest?.cycle_type ?? null;

  if (dates.length === 0) {
    // 캐시 미스 → 라이브 조회. catalog.getFacilityCalendar 의 실제 반환형은
    // { maxNights, cycleType, specialDates[{date, code, name}] } 다.
    // (예전 코드는 존재하지 않는 useDtList/hldtList 를 참조해 늘 빈 배열을 돌려줬다.)
    const session = await openSession();
    const data = await getFacilityCalendar(session, insttId);
    const now = nowIso();
    const ins = db.prepare(`
      INSERT INTO forest_calendar (instt_id, date, kind, name, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instt_id, date) DO UPDATE SET kind = excluded.kind, name = excluded.name, updated_at = excluded.updated_at
    `);
    for (const sd of data.specialDates || []) {
      ins.run(insttId, sd.date, sd.code === "01" ? "휴무" : "추첨", sd.name ?? null, now);
    }
    maxNights = data.maxNights ?? maxNights;
    cycleType = data.cycleType ?? cycleType;
    db.prepare(`UPDATE forest SET max_nights = ?, cycle_type = ? WHERE instt_id = ?`)
      .run(maxNights, cycleType, insttId);
    dates = (data.specialDates || [])
      .filter((sd) => sd.date >= today)
      .map((sd) => ({ date: sd.date, kind: sd.code === "01" ? "휴무" : "추첨", name: sd.name ?? null }));
  }

  // dates 에 없는 날짜는 선착순이다(특일만 저장한다).
  return { insttId, maxNights, cycleType, dates };
}

// ── 직렬화 (API계약 §6: 앱↔백엔드는 camelCase 계약값만 본다) ────────────────

function serializeForest(f) {
  return {
    insttId: f.instt_id, name: f.name, type: f.type,
    sido: f.sido_code, openYear: f.open_year, isNew: !!f.is_new,
    maxNights: f.max_nights ?? null, cycleType: f.cycle_type ?? null,
  };
}

function watchEvents(w, limit) {
  const rows = w.goods_id
    ? db.prepare(`
        SELECT event_type, from_state, to_state, occurred_at FROM watch_event
        WHERE instt_id = ? AND date = ? AND goods_id = ? ORDER BY occurred_at DESC LIMIT ?
      `).all(w.instt_id, w.date, w.goods_id, limit)
    : db.prepare(`
        SELECT event_type, from_state, to_state, occurred_at FROM watch_event
        WHERE instt_id = ? AND date = ? ORDER BY occurred_at DESC LIMIT ?
      `).all(w.instt_id, w.date, limit);
  return rows.map((e) => ({ type: e.event_type, from: e.from_state, state: e.to_state, at: e.occurred_at }));
}

function serializeWatch(w, { includeEvents = false } = {}) {
  let grades;
  try { grades = JSON.parse(w.notify_grades); } catch { grades = []; }

  // 폴링이 예정보다 크게 밀리면(예산 부족) 침묵시키지 않고 표면화한다 (ADR-0006 §3).
  const target = db.prepare(`
    SELECT next_due_at, interval_sec, last_polled_at, active FROM poll_target
    WHERE instt_id = ? AND date = ? AND nofpr = ? AND nights = ?
  `).get(w.instt_id, w.date, w.nofpr, w.nights);
  const overdueMs = target ? Date.now() - new Date(target.next_due_at).getTime() : 0;
  const pollingDelayed = !!target && target.active === 1 && overdueMs > target.interval_sec * 1000;

  const out = {
    id: w.id, deviceId: w.device_id, type: w.type,
    insttId: w.instt_id, goodsId: w.goods_id, roomLabel: w.room_label,
    date: w.date, rangeStart: w.range_start, rangeEnd: w.range_end,
    nights: w.nights, nofpr: w.nofpr,
    weekdayFilter: w.weekday_filter, priority: w.priority,
    notifyGrades: grades, waitDeadline: w.wait_deadline,
    active: !!w.active, paused: !!w.paused,
    currentStatus: w.last_status ?? null,
    currentWaitRank: w.last_wait_rank ?? null,
    lastCheckedAt: w.last_checked_at ?? null,
    lastNotifiedState: w.last_notified_state ?? null,
    lastNotifiedAt: w.last_notified_at ?? null,
    pollingDelayed,
    lastPolledAt: target?.last_polled_at ?? null,
  };
  if (includeEvents) out.recentEvents = watchEvents(w, 20);
  return out;
}

// ── 유틸 ───────────────────────────────────────────────────────────────────

/** 충돌 없는 감시 id. 예전엔 6자리 난수라 충돌 시 PK 위반으로 500 이 났다. */
function newWatchId() {
  for (let i = 0; i < 5; i++) {
    const id = "W" + crypto.randomBytes(6).toString("hex").toUpperCase();
    if (!db.prepare(`SELECT 1 FROM watch WHERE id = ?`).get(id)) return id;
  }
  throw new Error("watch id 생성 실패");
}

function badRequest(res, message) {
  return json(res, 400, { error: { code: "BAD_REQUEST", message } });
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body, null, 2), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "", size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error("요청 본문이 too large")); req.destroy(); return; }
      body += chunk;
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("JSON 본문이 올바르지 않습니다.")); }
    });
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`forest-finder API listening on http://localhost:${PORT}`);
  const c = coverageState();
  console.log(`레이트버짓 ${c.budget.limit} req/min · 커버리지 상한 N_max=${c.nMax} · 활성 target ${c.activeTargets}`);
});
