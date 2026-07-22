import http from "node:http";
import { SIDO } from "./constants.js";
import { openSession } from "./session.js";
import { getSidoList, getFacilityCalendar } from "./catalog.js";
import { searchRegionAvailability } from "./availability.js";
import { searchForestGoods } from "./goods.js";
import { initDb, db, encryptPassword, decryptPassword } from "./db.js";
import { populateForests } from "./db_populate.js";
import { getSessionContext, validateSession } from "./session_manager.js";
import { reconcilePollTargets, pollNextTarget } from "./scheduler.js";

try { process.loadEnvFile(); } catch { /* Ignore if .env doesn't exist */ }

const PORT = Number(process.env.PORT || 3000);
const APP_TOKEN = process.env.APP_TOKEN || "test-token";

// Initialize SQLite database and populate static forest meta on startup
initDb();
populateForests();
reconcilePollTargets();

// Start a background interval for the scheduler loop (ticks every 5 seconds)
setInterval(async () => {
  try {
    await pollNextTarget();
  } catch (err) {
    console.error("Scheduler tick error:", err);
  }
}, 5000);

// Periodically run reconciliation every 10 minutes
setInterval(() => {
  try {
    reconcilePollTargets();
  } catch (err) {
    console.error("Periodic reconciliation error:", err);
  }
}, 10 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // Health check endpoint is public (unauthenticated)
  if (url.pathname === "/health" || url.pathname === "/v1/health") {
    const session = db.prepare(`SELECT * FROM forest_session WHERE id = 1`).get();
    return json(res, 200, {
      ok: true,
      session: {
        loggedIn: !!session,
        valid: session ? !!session.valid : false,
        lastLoginAt: session ? session.established_at : null
      }
    });
  }

  // Auth check: Bearer token validation for all /v1/* endpoints
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== `Bearer ${APP_TOKEN}`) {
    return json(res, 401, { error: { code: "UNAUTHORIZED", message: "Bearer token is invalid or missing." } });
  }

  try {
    // 1. Sido List
    if (url.pathname === "/v1/sido" && req.method === "GET") {
      const session = await openSession();
      const list = await getSidoList(session);
      return json(res, 200, list);
    }

    // 2. Forests Meta List
    if (url.pathname === "/v1/forests" && req.method === "GET") {
      const sido = url.searchParams.get("sido");
      let forests;
      if (sido) {
        forests = db.prepare(`SELECT instt_id as insttId, name, type, open_year as openYear, is_new as isNew FROM forest WHERE sido_code = ?`).all(sido);
      } else {
        forests = db.prepare(`SELECT instt_id as insttId, name, type, open_year as openYear, is_new as isNew FROM forest`).all();
      }
      // Map is_new to boolean
      forests = forests.map(f => ({ ...f, isNew: !!f.isNew }));
      return json(res, 200, forests);
    }

    // 3. Forest Calendar
    const calendarMatch = url.pathname.match(/^\/v1\/forests\/([^/]+)\/calendar$/);
    if (calendarMatch && req.method === "GET") {
      const insttId = calendarMatch[1];
      const now = new Date().toISOString();
      const todayStr = now.slice(0, 10).replace(/-/g, ""); // YYYYMMDD
      
      // Try to load cached calendar dates for this forest
      let dates = db.prepare(`
        SELECT date, kind, name FROM forest_calendar
        WHERE instt_id = ? AND date >= ?
      `).all(insttId, todayStr);

      if (dates.length === 0) {
        // Cache miss: fetch calendar from foresttrip (unauthenticated)
        console.log(`Calendar cache miss for forest ${insttId}. Fetching live...`);
        const session = await openSession();
        const data = await getFacilityCalendar(session, insttId);
        
        const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO forest_calendar (instt_id, date, kind, name, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        
        // Save to DB
        const savedDates = [];
        if (data && data.useDtList) {
          // Parse useDtList / specialDates
          const specialMap = new Map();
          if (data.hldtList) {
            for (const item of data.hldtList) {
              specialMap.set(item.hldtDt, { kind: item.hldtSeCd === '01' ? '휴무' : '추첨', name: item.hldtNm });
            }
          }
          
          for (const dateObj of data.useDtList) {
            const dt = dateObj.useDt;
            const sp = specialMap.get(dt) || { kind: '선착순', name: null };
            insertStmt.run(insttId, dt, sp.kind, sp.name, now);
            savedDates.push({ date: dt, kind: sp.kind, name: sp.name });
          }
        }
        dates = savedDates;
      }
      
      const maxNightsInfo = db.prepare(`SELECT max(mxmmStngDayCnt) as mx FROM (SELECT 3 as mxmmStngDayCnt)`).get(); // standard default
      return json(res, 200, {
        insttId,
        maxNights: maxNightsInfo ? maxNightsInfo.mx : 3,
        cycleType: "WEEK",
        dates
      });
    }

    // 4. Forest Login credentials configuration
    if (url.pathname === "/v1/auth/forest-login") {
      if (req.method === "POST") {
        const body = await parseJsonBody(req);
        if (!body.loginId || !body.loginPwd) {
          return json(res, 400, { error: { code: "BAD_REQUEST", message: "loginId and loginPwd are required." } });
        }
        
        const encPwd = encryptPassword(body.loginPwd);
        const now = new Date().toISOString();
        
        // Save credential
        db.prepare(`
          INSERT OR REPLACE INTO forest_credential (id, login_id, enc_password, created_at, updated_at)
          VALUES (1, ?, ?, ?, ?)
        `).run(body.loginId, encPwd, now, now);

        // Reset session state
        db.prepare(`DELETE FROM forest_session WHERE id = 1`).run();

        // Perform validation login
        try {
          const testCtx = await getSessionContext();
          const valid = await validateSession(testCtx);
          await testCtx.close().catch(() => {});
          
          if (valid) {
            return json(res, 200, { loggedIn: true, valid: true, lastLoginAt: now });
          } else {
            // Delete cred if invalid
            db.prepare(`DELETE FROM forest_credential WHERE id = 1`).run();
            return json(res, 401, { error: { code: "LOGIN_FAILED", message: "숲나들e login authentication failed." } });
          }
        } catch (err) {
          db.prepare(`DELETE FROM forest_credential WHERE id = 1`).run();
          return json(res, 401, { error: { code: "LOGIN_FAILED", message: err.message } });
        }
      }
      
      if (req.method === "DELETE") {
        db.prepare(`DELETE FROM forest_credential WHERE id = 1`).run();
        db.prepare(`DELETE FROM forest_session WHERE id = 1`).run();
        return json(res, 200, { success: true });
      }
    }

    // 5. Auth status check
    if (url.pathname === "/v1/auth/status" && req.method === "GET") {
      const session = db.prepare(`SELECT * FROM forest_session WHERE id = 1`).get();
      return json(res, 200, {
        loggedIn: !!session,
        valid: session ? !!session.valid : false,
        lastLoginAt: session ? session.established_at : null,
        needsRelogin: session ? !!session.needs_relogin : false
      });
    }

    // 6. Devices registration and configuration
    if (url.pathname === "/v1/devices" && req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body.deviceId) {
        return json(res, 400, { error: { code: "BAD_REQUEST", message: "deviceId is required." } });
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR REPLACE INTO device (device_id, fcm_token, platform, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(body.deviceId, body.fcmToken || null, body.platform || "android", now, now);
      return json(res, 200, { deviceId: body.deviceId });
    }

    const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
    if (deviceMatch && req.method === "PATCH") {
      const deviceId = deviceMatch[1];
      const body = await parseJsonBody(req);
      const now = new Date().toISOString();
      
      db.prepare(`
        UPDATE device
        SET dnd_start = ?, dnd_end = ?, urgent_bypass_dnd = ?, notify_rank_improve = ?, updated_at = ?
        WHERE device_id = ?
      `).run(
        body.dndStart || null,
        body.dndEnd || null,
        body.urgentBypassDnd !== undefined ? (body.urgentBypassDnd ? 1 : 0) : 1,
        body.notifyRankImprove !== undefined ? (body.notifyRankImprove ? 1 : 0) : 0,
        now,
        deviceId
      );
      return json(res, 200, { success: true });
    }

    // 7. Watches CRUD
    if (url.pathname === "/v1/watches") {
      if (req.method === "GET") {
        const deviceId = url.searchParams.get("deviceId");
        if (!deviceId) return json(res, 400, { error: "deviceId is required." });
        const watches = db.prepare(`SELECT * FROM watch WHERE device_id = ?`).all(deviceId);
        return json(res, 200, watches.map(w => ({
          ...w,
          active: !!w.active,
          paused: !!w.paused,
          notifyGrades: JSON.parse(w.notify_grades)
        })));
      }

      if (req.method === "POST") {
        const body = await parseJsonBody(req);
        if (!body.deviceId || !body.type || !body.insttId || !body.date) {
          return json(res, 400, { error: { code: "BAD_REQUEST", message: "deviceId, type, insttId, and date are required." } });
        }
        
        // Calculate wait deadline: D-2 of target date
        let waitDeadline = null;
        try {
          const dateStr = body.date; // YYYYMMDD
          const y = parseInt(dateStr.slice(0, 4), 10);
          const m = parseInt(dateStr.slice(4, 6), 10) - 1;
          const d = parseInt(dateStr.slice(6, 8), 10);
          const targetDate = new Date(Date.UTC(y, m, d - 2));
          const p = (n) => String(n).padStart(2, "0");
          waitDeadline = `${targetDate.getUTCFullYear()}${p(targetDate.getUTCMonth() + 1)}${p(targetDate.getUTCDate())}`;
        } catch (e) {
          // ignore
        }

        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO watch (id, device_id, type, instt_id, goods_id, room_label, nofpr, nights, date, priority, notify_grades, wait_deadline, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "W" + Math.floor(Math.random() * 900000 + 100000),
          body.deviceId,
          body.type,
          body.insttId,
          body.goodsId || null,
          body.roomLabel || null,
          body.nofpr || 2,
          body.nights || 1,
          body.date,
          body.priority || "normal",
          JSON.stringify(body.notifyGrades || ["예약가능"]),
          waitDeadline,
          now
        );
        
        reconcilePollTargets();
        return json(res, 201, { success: true });
      }
    }

    const watchMatch = url.pathname.match(/^\/v1\/watches\/([^/]+)$/);
    if (watchMatch) {
      const id = watchMatch[1];
      
      if (req.method === "GET") {
        const watch = db.prepare(`SELECT * FROM watch WHERE id = ?`).get(id);
        if (!watch) return json(res, 404, { error: "watch not found" });
        return json(res, 200, {
          ...watch,
          active: !!watch.active,
          paused: !!watch.paused,
          notifyGrades: JSON.parse(watch.notify_grades)
        });
      }

      if (req.method === "PATCH") {
        const body = await parseJsonBody(req);
        // Updates active, paused, priority, notifyGrades etc.
        const setClauses = [];
        const params = [];
        for (const [key, val] of Object.entries(body)) {
          if (key === "paused") {
            setClauses.push("paused = ?");
            params.push(val ? 1 : 0);
          } else if (key === "active") {
            setClauses.push("active = ?");
            params.push(val ? 1 : 0);
          } else if (key === "priority") {
            setClauses.push("priority = ?");
            params.push(val);
          } else if (key === "notifyGrades") {
            setClauses.push("notify_grades = ?");
            params.push(JSON.stringify(val));
          }
        }
        
        if (setClauses.length > 0) {
          params.push(id);
          db.prepare(`UPDATE watch SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
          reconcilePollTargets();
        }
        return json(res, 200, { success: true });
      }

      if (req.method === "DELETE") {
        db.prepare(`DELETE FROM watch WHERE id = ?`).run(id);
        reconcilePollTargets();
        return json(res, 200, { success: true });
      }
    }

    const watchEventsMatch = url.pathname.match(/^\/v1\/watches\/([^/]+)\/events$/);
    if (watchEventsMatch && req.method === "GET") {
      const watchId = watchEventsMatch[1];
      const watch = db.prepare(`SELECT instt_id, date, goods_id FROM watch WHERE id = ?`).get(watchId);
      if (!watch) return json(res, 404, { error: "watch not found" });
      
      let events;
      if (watch.goods_id) {
        events = db.prepare(`
          SELECT event_type as type, from_state, to_state, occurred_at as at
          FROM watch_event
          WHERE instt_id = ? AND date = ? AND goods_id = ?
          ORDER BY occurred_at DESC
        `).all(watch.instt_id, watch.date, watch.goods_id);
      } else {
        events = db.prepare(`
          SELECT event_type as type, from_state, to_state, occurred_at as at
          FROM watch_event
          WHERE instt_id = ? AND date = ?
          ORDER BY occurred_at DESC
        `).all(watch.instt_id, watch.date);
      }
      return json(res, 200, events);
    }

    // 8. Search (Snapshot based query, ADR-0003)
    if (url.pathname === "/v1/search" && req.method === "GET") {
      const date = url.searchParams.get("date");
      const nights = Number(url.searchParams.get("nights") || 1);
      const nofpr = Number(url.searchParams.get("nofpr") || 2);
      const sido = url.searchParams.get("sido");

      if (!date) return json(res, 400, { error: "date (YYYYMMDD) is required." });

      const checkout = addDays(date, nights);
      console.log(`Search request: date ${date}, sido ${sido}`);

      // Refresh availability data synchronously (lightweight / unauthenticated check)
      let rAvail = null;
      try {
        rAvail = await searchRegionAvailability({ sido: sido || "2", checkin: date, checkout, nofpr });
      } catch (err) {
        console.error("Availability search failed:", err);
      }

      const now = new Date().toISOString();
      const availSnapshotAt = rAvail ? now : null;

      // Update forest_availability table in DB
      if (rAvail && rAvail.forests) {
        const insertAvail = db.prepare(`
          INSERT INTO forest_availability (instt_id, date, nofpr, status, reservable, room_count, scanned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const f of rAvail.forests) {
          const status = f.available ? "예약가능" : "예약불가";
          const instt = db.prepare(`SELECT instt_id FROM forest WHERE name = ?`).get(f.name);
          if (instt) {
            insertAvail.run(instt.instt_id, date, nofpr, status, f.available ? 1 : 0, 36, now);
          }
        }
      }

      // Query forests and combine availability + metadata + room check status
      const queryStr = sido 
        ? `SELECT * FROM forest WHERE sido_code = ?`
        : `SELECT * FROM forest`;
      const queryParams = sido ? [sido] : [];
      const forests = db.prepare(queryStr).all(...queryParams);

      const responseForests = forests.map(f => {
        // Find availability status
        const avail = db.prepare(`
          SELECT status, reservable FROM forest_availability
          WHERE instt_id = ? AND date = ? AND nofpr = ?
          ORDER BY scanned_at DESC LIMIT 1
        `).get(f.instt_id, date, nofpr);

        // Find wait cover details (if we poll rooms for this forest)
        const isWatched = db.prepare(`
          SELECT id FROM watch
          WHERE instt_id = ? AND date = ? AND active = 1 AND paused = 0 LIMIT 1
        `).get(f.instt_id, date);

        const lastScan = db.prepare(`
          SELECT id, scanned_at FROM scan
          WHERE instt_id = ? AND date = ? AND ok = 1
          ORDER BY scanned_at DESC LIMIT 1
        `).get(f.instt_id, date);

        const waitSnapshotAt = lastScan ? lastScan.scanned_at : null;

        let waitableRooms = null;
        if (lastScan) {
          const waitCount = db.prepare(`
            SELECT count(*) as count FROM room_state
            WHERE scan_id = ? AND status = '대기가능'
          `).get(lastScan.id);
          waitableRooms = waitCount ? waitCount.count : 0;
        }

        return {
          insttId: f.instt_id,
          name: f.name,
          type: f.type,
          openYear: f.open_year,
          isNew: !!f.is_new,
          reservable: avail ? avail.reservable === 1 : false,
          reservableRooms: avail && avail.reservable === 1 ? 4 : 0, // mock count
          roomCount: 36,
          waitable: waitableRooms !== null && waitableRooms > 0,
          waitableRooms: waitableRooms,
          waitCovered: !!isWatched,
          waitSnapshotAt
        };
      });

      return json(res, 200, {
        date,
        nights,
        nofpr,
        sido: sido || null,
        availSnapshotAt,
        waitSnapshotAt: now,
        refreshing: { avail: false, wait: false },
        dayKind: "선착순",
        forests: responseForests
      });
    }

    // 9. Search Refresh
    if (url.pathname === "/v1/search/refresh" && req.method === "POST") {
      const body = await parseJsonBody(req);
      console.log("Search refresh requested for:", body);
      // We can run a background job or just return 202
      return json(res, 202, { jobId: "job_" + Math.floor(Math.random() * 900000 + 100000) });
    }

    // 10. Forest Rooms (On-demand query, §3)
    const roomsMatch = url.pathname.match(/^\/v1\/forests\/([^/]+)\/rooms$/);
    if (roomsMatch && req.method === "GET") {
      const insttId = roomsMatch[1];
      const date = url.searchParams.get("date");
      const nights = Number(url.searchParams.get("nights") || 1);
      const nofpr = Number(url.searchParams.get("nofpr") || 2);
      
      if (!date) return json(res, 400, { error: "date (YYYYMMDD) is required." });

      const checkout = addDays(date, nights);
      
      const forest = db.prepare(`SELECT name, sido_code FROM forest WHERE instt_id = ?`).get(insttId);
      if (!forest) return json(res, 404, { error: "forest not found in DB." });

      console.log(`On-demand rooms query for: ${forest.name} (${insttId}) on ${date}`);

      let sessionCtx = null;
      try {
        sessionCtx = await getSessionContext();
        const result = await searchForestGoods({
          sido: forest.sido_code,
          insttId,
          checkin: date,
          checkout,
          nofpr,
          context: sessionCtx,
          includeWait: true
        });

        if (result.ok && !result.needLogin) {
          // Record scan history
          const now = new Date().toISOString();
          const scanInfo = db.prepare(`
            INSERT INTO scan (instt_id, date, nofpr, nights, scanned_at, source, ok)
            VALUES (?, ?, ?, ?, ?, 'ondemand', 1)
          `).run(insttId, date, nofpr, nights, now);

          const scanId = scanInfo.lastInsertRowid;

          const insertState = db.prepare(`
            INSERT INTO room_state (scan_id, instt_id, date, goods_id, room_label, facility, capacity, price, status, reservable, waitable, wait_rank, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          
          for (const room of result.rooms) {
            insertState.run(
              scanId,
              insttId,
              date,
              room.goodsId,
              room.detail,
              room.facility,
              room.capacity,
              room.price,
              room.status,
              room.available ? 1 : 0,
              room.waitable ? 1 : 0,
              room.waitRank,
              now
            );
          }

          // Process transitions and pushes
          processRoomTransitions(insttId, date, result.rooms, scanId);

          return json(res, 200, {
            insttId,
            date,
            nights,
            nofpr,
            fetchedAt: now,
            pagesTraversed: result.pagesTraversed || 1,
            complete: !!result.complete,
            rooms: result.rooms
          });
        } else {
          return json(res, 500, { error: { code: "FETCH_FAILED", message: "Failed to load goods page from 숲나들e." } });
        }
      } catch (err) {
        return json(res, 500, { error: { code: "FETCH_FAILED", message: err.message } });
      } finally {
        if (sessionCtx) {
          await sessionCtx.close().catch(() => {});
        }
      }
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

// Helper functions
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
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function addDays(yyyymmdd, days) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6) - 1, d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m, d + days));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`;
}

// Same logic as scheduler.js to process transitions on on-demand queries
function processRoomTransitions(insttId, date, rooms, scanId) {
  const now = new Date().toISOString();
  
  for (const room of rooms) {
    const lastState = db.prepare(`
      SELECT status, wait_rank FROM room_state
      WHERE instt_id = ? AND date = ? AND goods_id = ? AND scan_id != ?
      ORDER BY scanned_at DESC LIMIT 1
    `).get(insttId, date, room.goodsId, scanId);
    
    const from_status = lastState ? lastState.status : null;
    const from_rank = lastState ? lastState.wait_rank : null;
    const to_status = room.status;
    const to_rank = room.waitRank;
    
    if (from_status !== to_status || from_rank !== to_rank) {
      let eventType = null;
      if (to_status === "예약가능" && from_status !== "예약가능") {
        eventType = "opened";
      } else if (to_status === null && from_status !== null) {
        eventType = "closed";
      } else if (to_status === "대기가능" && from_status !== "대기가능") {
        eventType = "opened";
      } else if (to_status === "대기가능" && from_status === "대기가능" && to_rank !== from_rank) {
        eventType = "rank_changed";
      }
      
      if (eventType) {
        db.prepare(`
          INSERT INTO watch_event (instt_id, date, goods_id, event_type, from_state, to_state, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(insttId, date, room.goodsId, eventType, from_status, to_status, now);
      }
    }
  }
}

server.listen(PORT, () => {
  console.log(`forest-finder API listening on http://localhost:${PORT}`);
});
