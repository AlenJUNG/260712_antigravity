// login-save 로 만든 auth.json 을 서버 DB(forest_session)로 가져온다.
//
// CLI(`poc.js`)는 auth.json 을 직접 읽지만 서버는 DB의 forest_session 을 쓴다.
// 사용자가 `login-save.cmd` 로 로그인한 뒤 이 스크립트를 한 번 돌리면 서버가
// **재로그인 없이** 그 세션을 이어받는다.
//
// 동시에 .env 의 ID/PW 를 암호화해 forest_credential 에 넣어 둔다. 세션이 만료됐을 때
// 코드가 스스로 재로그인할 수 있게 하기 위한 것으로, 자격증명을 읽는 주체는 코드다
// (ADR-0002: 입력 주체는 사용자, 자동 재로그인 주체는 코드). 값은 로그에 남기지 않는다.
//
//   node src/bootstrap-session.js

import "./env.js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, initDb, encryptPassword } from "./db.js";
import { nowIso } from "./dates.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const authPath = join(ROOT, "auth.json");

initDb();

// 1) auth.json → forest_session
if (!existsSync(authPath)) {
  console.error(`auth.json 이 없습니다: ${authPath}`);
  console.error("먼저 login-save.cmd 로 로그인해 세션을 저장하세요.");
  process.exit(1);
}
const storageState = readFileSync(authPath, "utf8");
try {
  JSON.parse(storageState);
} catch {
  console.error("auth.json 을 JSON 으로 읽을 수 없습니다.");
  process.exit(1);
}
const now = nowIso();
db.prepare(`
  INSERT INTO forest_session (id, storage_state, established_at, last_checked, valid, needs_relogin)
  VALUES (1, ?, ?, ?, 1, 0)
  ON CONFLICT(id) DO UPDATE SET
    storage_state = excluded.storage_state,
    established_at = excluded.established_at,
    last_checked = excluded.last_checked,
    valid = 1, needs_relogin = 0
`).run(storageState, now, now);
console.log(`세션을 DB로 가져왔습니다 (auth.json → forest_session, established_at=${now}).`);

// 2) .env 의 ID/PW → forest_credential (자동 재로그인용, 암호화 저장)
const id = process.env.ID ?? process.env.FOREST_ID;
const pw = process.env.PW ?? process.env.FOREST_PW;
if (id && pw) {
  db.prepare(`
    INSERT INTO forest_credential (id, login_id, enc_password, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      login_id = excluded.login_id, enc_password = excluded.enc_password, updated_at = excluded.updated_at
  `).run(id, encryptPassword(pw), now, now);
  console.log(`자동 재로그인용 자격증명을 암호화 저장했습니다 (로그인ID 길이 ${id.length}자).`);
} else {
  console.warn("`.env` 에 ID/PW 가 없어 자격증명을 저장하지 않았습니다.");
  console.warn("→ 세션 만료 시 자동 재로그인이 불가하며, 폴링이 실패로 남습니다.");
}
