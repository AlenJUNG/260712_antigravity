// .env 로더 — **가장 먼저 평가돼야 하는 모듈.**
//
// ESM 은 임포트 대상을 임포트한 모듈의 본문보다 먼저 평가한다. 그래서 server.js 본문에서
// process.loadEnvFile() 를 부르면 이미 db.js 가 평가된 뒤라 ENCRYPTION_KEY 를 못 읽고
// "키가 없다"며 기동이 거부된다. 환경변수를 모듈 스코프에서 읽는 파일(db.js, server.js,
// rateBudget.js …)은 이 모듈을 첫 번째 import 로 둘 것.
//
// 이미 설정된 프로세스 환경변수는 .env 가 덮어쓰지 않는다(Node 기본 동작).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(ROOT, ".env");

if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);   // cwd 와 무관하게 프로젝트 루트의 .env 를 읽는다
  } catch (e) {
    console.warn(`.env 로드 실패(무시): ${e.message}`);
  }
}
