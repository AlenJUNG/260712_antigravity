import { db } from "./db.js";
import { searchForestGoods } from "./goods.js";
import { getSessionContext } from "./session_manager.js";
import { searchRegionAvailability } from "./availability.js";
import { SIDO } from "./constants.js";
import { appendFileSync } from "node:fs";

// Request limits (Rate Budget, ADR-0006)
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Max 10 requests/min
const requestHistory = []; // Timestamps of requests

function checkRateBudget() {
  const now = Date.now();
  // Clear old entries
  while (requestHistory.length > 0 && now - requestHistory[0] > RATE_LIMIT_WINDOW_MS) {
    requestHistory.shift();
  }
  return requestHistory.length < MAX_REQUESTS_PER_WINDOW;
}

function recordRequest() {
  requestHistory.push(Date.now());
}

/**
 * Periodically sync watches into poll_target (Reconciliation, M3)
 */
export function reconcilePollTargets() {
  console.log("Running reconciliation...");
  const now = new Date().toISOString();
  
  // 1. Get all active, unpaused watches that have a single date and aren't expired
  const activeWatches = db.prepare(`
    SELECT instt_id, date, nofpr, nights, priority
    FROM watch
    WHERE active = 1 AND paused = 0 AND date IS NOT NULL AND date >= ?
  `).all(now.slice(0, 8)); // YYYYMMDD comparison

  // 2. Insert or update active poll targets
  const insertTarget = db.prepare(`
    INSERT INTO poll_target (instt_id, date, nofpr, nights, next_due_at, interval_sec, priority, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(instt_id, date, nofpr, nights) DO UPDATE SET
      priority = excluded.priority,
      active = 1
  `);

  for (const w of activeWatches) {
    // Default interval based on priority: urgent = 300s, normal = 600s
    const interval = w.priority === 'urgent' ? 300 : 600;
    insertTarget.run(w.instt_id, w.date, w.nofpr, w.nights, now, interval, w.priority);
  }

  // 3. Deactivate targets that are no longer referenced by any active watch
  db.prepare(`
    UPDATE poll_target
    SET active = 0
    WHERE active = 1 AND (instt_id, date, nofpr, nights) NOT IN (
      SELECT instt_id, date, nofpr, nights
      FROM watch
      WHERE active = 1 AND paused = 0 AND date IS NOT NULL
    )
  `).run();

  // 4. Deactivate expired targets (older than today)
  db.prepare(`
    UPDATE poll_target
    SET active = 0
    WHERE date < ?
  `).run(now.slice(0, 8));
  
  console.log("Reconciliation finished.");
}

/**
 * Calculate adaptive interval based on criteria (M4)
 */
function calculateAdaptiveInterval(target) {
  const now = new Date();
  const dateStr = target.date; // YYYYMMDD
  
  // Parse target date
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(4, 6), 10) - 1;
  const d = parseInt(dateStr.slice(6, 8), 10);
  const targetDate = new Date(y, m, d);
  
  const diffDays = Math.ceil((targetDate - now) / (1000 * 60 * 60 * 24));
  
  let interval = 600; // Default 10 mins

  if (target.priority === 'urgent') {
    interval = 300; // 5 mins
  }
  
  // Imminent date (within 2 days)
  if (diffDays <= 2 && diffDays >= 0) {
    interval = Math.min(interval, 180); // 3 mins
  }
  
  // Peak hours (9 AM to 6 PM)
  const hour = now.getHours();
  if (hour >= 9 && hour < 18) {
    interval = Math.min(interval, 300); // 5 mins peak hours
  }
  
  return interval;
}

/**
 * Handle room state transitions and notifications
 */
function processRoomTransitions(insttId, date, rooms, scanId) {
  const now = new Date().toISOString();
  
  for (const room of rooms) {
    // Get last room state for comparison
    const lastState = db.prepare(`
      SELECT status, wait_rank FROM room_state
      WHERE instt_id = ? AND date = ? AND goods_id = ?
      ORDER BY scanned_at DESC LIMIT 1
    `).get(insttId, date, room.goodsId);
    
    const from_status = lastState ? lastState.status : null;
    const from_rank = lastState ? lastState.wait_rank : null;
    const to_status = room.status; // 예약가능/대기가능/null
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
        // Record event
        db.prepare(`
          INSERT INTO watch_event (instt_id, date, goods_id, event_type, from_state, to_state, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(insttId, date, room.goodsId, eventType, from_status, to_status, now);
        
        // Trigger notifications
        triggerNotificationsForRoom(insttId, date, room, eventType, from_status);
      }
    }
  }
}

/**
 * Match transitions to active watches and send pushes (M2, FCM stub)
 */
function triggerNotificationsForRoom(insttId, date, room, eventType, fromStatus) {
  const now = new Date().toISOString();
  
  // 1. Match 'room' watches (specific goodsId)
  const roomWatches = db.prepare(`
    SELECT * FROM watch
    WHERE instt_id = ? AND date = ? AND goods_id = ? AND active = 1 AND paused = 0
  `).all(insttId, date, room.goodsId);
  
  // 2. Match 'forest' watches (any room in the forest)
  const forestWatches = db.prepare(`
    SELECT * FROM watch
    WHERE instt_id = ? AND date = ? AND type = 'forest' AND active = 1 AND paused = 0
  `).all(insttId, date);

  const allWatches = [...roomWatches, ...forestWatches];

  for (const w of allWatches) {
    const notifyGrades = JSON.parse(w.notify_grades); // e.g. ["예약가능", "대기가능"]
    const status = room.status; // 예약가능 / 대기가능
    
    if (status && notifyGrades.includes(status)) {
      // Check throttle: limit same state notifications to once per 10 minutes
      const lastNotif = db.prepare(`
        SELECT sent_at FROM notification
        WHERE watch_id = ? AND goods_id = ? AND state = ?
        ORDER BY sent_at DESC LIMIT 1
      `).get(w.id, room.goodsId, status);
      
      if (lastNotif) {
        const diffMs = Date.now() - new Date(lastNotif.sent_at).getTime();
        if (diffMs < 10 * 60 * 1000) {
          // Suppress duplicate notification
          continue;
        }
      }
      
      // Send notification
      const grade = status === "예약가능" ? "예약가능(긴급)" : "대기가능(일반)";
      const title = `[숲나들e] ${grade} 알림`;
      const body = `${room.detail}이 ${status} 상태가 되었습니다. (${room.price})`;
      const payload = JSON.stringify({
        click_action: "https://www.foresttrip.go.kr/rep/or/fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001",
        insttId: insttId,
        date: date,
        goodsId: room.goodsId,
        roomLabel: room.detail,
        status: status
      });
      
      // Insert log
      db.prepare(`
        INSERT INTO notification (watch_id, device_id, grade, state, date, goods_id, sent_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(w.id, w.device_id, grade, status, date, room.goodsId, now, payload);
      
      // Update watch latest status cache
      db.prepare(`
        UPDATE watch
        SET last_status = ?, last_wait_rank = ?, last_notified_state = ?, last_notified_at = ?
        WHERE id = ?
      `).run(status, room.waitRank, status, now, w.id);

      // FCM Stub Log
      const logMsg = `[FCM PUSH] To device ${w.device_id} | Title: ${title} | Body: ${body} | Payload: ${payload}\n`;
      appendFileSync("data/pushes.log", `${now} - ${logMsg}`);
      console.log(logMsg);
    }
  }
}

/**
 * Execute poll check (Background worker, M4)
 */
export async function pollNextTarget() {
  if (!checkRateBudget()) {
    // Skip this tick to stay within rate budget
    return;
  }

  const now = new Date().toISOString();
  
  // Find highest priority due target
  const target = db.prepare(`
    SELECT * FROM poll_target
    WHERE active = 1 AND next_due_at <= ?
    ORDER BY priority DESC, next_due_at ASC
    LIMIT 1
  `).get(now);

  if (!target) {
    return;
  }

  recordRequest();
  console.log(`Polling target: Forest ${target.instt_id}, Date ${target.date}, nofpr ${target.nofpr}`);

  let sessionCtx = null;
  let ok = 0;
  
  try {
    sessionCtx = await getSessionContext();
    
    // Resolve checkout date (nights)
    const checkout = addDays(target.date, target.nights);
    
    // Fetch from foresttrip using session
    const checkSido = "2"; // Fallback to Gangwon or retrieve from forest database
    const forest = db.prepare(`SELECT sido_code FROM forest WHERE instt_id = ?`).get(target.instt_id);
    const sido = forest ? forest.sido_code : checkSido;

    const result = await searchForestGoods({
      sido,
      insttId: target.instt_id,
      checkin: target.date,
      checkout,
      nofpr: target.nofpr,
      context: sessionCtx,
      includeWait: true
    });

    if (result.ok && !result.needLogin) {
      ok = 1;
      
      // 1. Record Scan
      const scanInfo = db.prepare(`
        INSERT INTO scan (instt_id, date, nofpr, nights, scanned_at, source, ok)
        VALUES (?, ?, ?, ?, ?, 'watch', 1)
      `).run(target.instt_id, target.date, target.nofpr, target.nights, now);
      
      const scanId = scanInfo.lastInsertRowid;
      
      // 2. Insert Room States
      const insertState = db.prepare(`
        INSERT INTO room_state (scan_id, instt_id, date, goods_id, room_label, facility, capacity, price, status, reservable, waitable, wait_rank, scanned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const room of result.rooms) {
        insertState.run(
          scanId,
          target.instt_id,
          target.date,
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
      
      // 3. Process transitions and pushes
      processRoomTransitions(target.instt_id, target.date, result.rooms, scanId);
      
    } else {
      console.warn(`Scan returned not OK (ok: ${result.ok}, needLogin: ${result.needLogin})`);
    }

  } catch (err) {
    console.error(`Failed to poll target ${target.id}:`, err.message);
  } finally {
    if (sessionCtx) {
      await sessionCtx.close().catch(() => {});
    }
  }

  // Update target polling schedule details
  const nextInterval = calculateAdaptiveInterval(target);
  const nextDue = new Date(Date.now() + nextInterval * 1000).toISOString();
  
  db.prepare(`
    UPDATE poll_target
    SET last_polled_at = ?, next_due_at = ?, interval_sec = ?, active = ?
    WHERE id = ?
  `).run(now, nextDue, nextInterval, ok, target.id); // Deactivate target if failed completely (ok = 0)
}

function addDays(yyyymmdd, days) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6) - 1, d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m, d + days));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`;
}
