import { getBrowser } from "./browser.js";
import { db, decryptPassword } from "./db.js";
import { createLoggedInContext } from "./login.js";
import { UA } from "./constants.js";

/**
 * Get a logged-in Playwright context, either by loading the cached session
 * or by logging in again using the encrypted credentials in the database.
 */
export async function getSessionContext() {
  // 1. Check if there is an active valid session
  const sessionStmt = db.prepare(`SELECT * FROM forest_session WHERE id = 1`);
  const session = sessionStmt.get();

  const browser = await getBrowser();

  if (session && session.valid && !session.needs_relogin) {
    try {
      const storageState = JSON.parse(session.storage_state);
      const ctx = await browser.newContext({
        userAgent: UA,
        locale: "ko-KR",
        viewport: { width: 1360, height: 1000 },
        storageState: storageState
      });
      return ctx;
    } catch (e) {
      console.error("Failed to restore session from storageState, will try relogin:", e);
    }
  }

  // 2. Need relogin. Get credentials.
  const credStmt = db.prepare(`SELECT * FROM forest_credential WHERE id = 1`);
  const cred = credStmt.get();

  if (!cred) {
    throw new Error("Credentials not registered in database. Call /auth/forest-login first.");
  }

  if (session && session.needs_relogin) {
    throw new Error("Auto-relogin is blocked because previous attempts failed (account lock prevention). Re-authenticate.");
  }

  const decryptedPassword = decryptPassword(cred.enc_password);
  if (!decryptedPassword) {
    throw new Error("Failed to decrypt credentials password.");
  }

  console.log("Attempting headless 숲나들e login...");
  try {
    const ctx = await createLoggedInContext({
      id: cred.login_id,
      pw: decryptedPassword
    });

    // Save successful session state
    const storageState = await ctx.storageState();
    const now = new Date().toISOString();
    
    // Insert or replace session
    db.prepare(`
      INSERT OR REPLACE INTO forest_session (id, storage_state, established_at, last_checked, valid, needs_relogin)
      VALUES (1, ?, ?, ?, 1, 0)
    `).run(JSON.stringify(storageState), now, now);

    console.log("Headless login successful, session saved.");
    return ctx;
  } catch (err) {
    console.error("Headless login failed:", err.message);
    
    // Mark relogin required and session invalid to prevent infinite attempts
    db.prepare(`
      INSERT OR REPLACE INTO forest_session (id, storage_state, established_at, last_checked, valid, needs_relogin)
      VALUES (1, '', ?, ?, 0, 1)
    `).run(new Date().toISOString(), new Date().toISOString());

    throw new Error("Auto-login failed: " + err.message);
  }
}

/**
 * Validate that the current session context is still valid.
 * E.g., open a page and check if we are redirected to login.
 */
export async function validateSession(ctx) {
  const page = await ctx.newPage();
  try {
    // Go to an endpoint requiring login
    // Let's go to index.do
    await page.goto("https://www.foresttrip.go.kr/com/index.do", { waitUntil: "networkidle" });
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const loggedIn = text.includes("로그아웃") || !text.includes("로그인");
    
    const now = new Date().toISOString();
    if (!loggedIn) {
      // Invalidate session
      db.prepare(`UPDATE forest_session SET valid = 0 WHERE id = 1`).run();
      return false;
    } else {
      // Update check time
      db.prepare(`UPDATE forest_session SET last_checked = ? WHERE id = 1`).run(now);
      return true;
    }
  } catch (e) {
    return false;
  } finally {
    await page.close();
  }
}
