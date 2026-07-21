# forest-finder (숲나들e 자연휴양림 예약가능 조회)

숲나들e(foresttrip.go.kr)에서 **날짜 + 시/도**로 예약가능한 전국 자연휴양림을 찾는 서비스의 개념검증(PoC).

### 📄 산출물 문서
- **[코드설계서.md](./코드설계서.md)** — 아키텍처·모듈·데이터흐름·API·로드맵
- **[조사보고서.md](./조사보고서.md)** — 데이터소스·엔드포인트·로그인게이트 실측 근거

## 무엇을 검증했나

실제 사이트 내부 엔드포인트를 분석/실호출해 확인한 사실:

| 구분 | 엔드포인트 | 상태 |
|---|---|---|
| 시/도 목록 | `selectSiDoList.do` | ✅ 순수 HTTP OK (JSON) |
| 시/도별 휴양림 목록 | `selectInsttListForSearch.do?srchSido=` | ✅ 순수 HTTP OK (JSON) |
| 휴양림 달력 메타(휴무·추첨일) | `selectFcFsRcfrsFcltInfo.do?insttId=` | ✅ 순수 HTTP OK (JSON) |
| **예약가능 휴양림 목록(지역+날짜)** | `fcfsRsrvtRcrfrDtlDetls.do` | ⛔ **NetFunnel 게이트** → 브라우저 필요 |
| 예약가능 객실(휴양림+날짜) | `sssn/fcfsRsrvtPssblGoodsDetls.do` | ⛔ NetFunnel 게이트 |

`fcfsRsrvtRcrfrDtlDetls.do` 를 curl로 직접 치면 `302 → /com/alert.do`
("정상적인 접근으로 다시시도해주시기 바랍니다") 로 튕긴다. 서버가 유효한
`netfunnel_key`(STCLab 가상대기열 토큰)를 요구하기 때문. 그래서 이 부분만
**실제 브라우저(Playwright)** 로 페이지를 띄워 키를 정상 발급받아 조회한다.

## 아키텍처(요약)

```
수집기(batch, Node+Playwright) ─ 주기 실행
  ├ 카탈로그/달력 : 순수 HTTP (session.js, catalog.js)
  └ 예약가능 잔여 : headful 브라우저로 NetFunnel 통과 (availability.js)
        ↓ 정규화
   [DB/캐시]  휴양림 × 날짜 × {가능/대기/마감/추첨}
        ↓
  REST API 서버  →  (향후) Android 앱 / 웹 프론트가 소비
```

> 스크래퍼는 서버에서만 돈다. Android 앱은 이 REST API를 호출하는 **클라이언트**이며
> 앱 프레임워크(Kotlin/Flutter 등)는 나중에 자유롭게 고르면 된다.

## 실행

```bash
cd 260721_foresttrip
npm install
npx playwright install chromium   # 최초 1회 (Chromium 다운로드)

# 0) 국립 휴양림 개장연도 수집 (최초 1회 / 연 1회 갱신, 브라우저 불필요)
npm run collect          # → data/national-open-years.json (47곳)

# 1) 카탈로그/메타 (브라우저 불필요, 즉시 동작)
npm run catalog          # 기본 강원(2)
node src/poc.js catalog 8   # 부산/경남

# 2) 예약가능 조회 CLI (브라우저가 눈에 보이게 뜸)
node src/poc.js search 2 20260819 20260820 2
#   → artifacts/result.html, result.png 에 결과 페이지가 저장됨
#   HEADLESS=1 로 주면 창 없이 실행

# 3) REST API 서버 (앱/프론트가 호출할 인터페이스)
npm run serve                       # http://localhost:3000 (PORT 로 변경, HEADLESS=1 권장)
#   GET /health
#   GET /sido
#   GET /available?sido=7&date=20260805&nights=1&nofpr=2

# 4) 객실(시설) 단위 조회 — 로그인 필요 (본인 숲나들e 계정)
#    자격증명은 프로젝트 루트 .env 의 FOREST_ID / FOREST_PW 에서 자동 로드된다.
node src/poc.js rooms 2 0111 20260819 20260820 2
#   → artifacts/goods.html, goods.png 저장 + 잠정 파싱 결과 출력
```

### 객실 단위 = 로그인 필수 (검증 완료)
- 휴양림 단위(시/도·휴양림명·개관연도·신축·예약가능여부)는 **비로그인** 조회 가능.
- **숙박시설·시설상세·대기가능** 은 `fcfsRsrvtPssblGoodsDetls.do` 에서 오는데,
  이 페이지는 **로그인 세션이 없으면 로그인 화면**을 반환한다(실측: `loginErrorCode -5`).
- `rooms` 명령은 `.env` 의 `ID`/`PW` 계정으로 로그인한다(자동 로드).
  코드는 자격증명 값을 저장/로깅하지 않으며, `.env` 는 `.gitignore` 로 커밋 제외된다.
  **비밀번호 5회 오류 시 계정 잠금** 주의.
- 로그인 후 객실 DOM 구조를 확정해야 `숙박시설`/`시설상세`/`예약·대기` 파싱이 완성된다
  (`goods.js` 파서는 현재 잠정본 → 실제 `goods.html` 로 확정 예정).

### API 응답 예 (`GET /available`)
```json
{
  "cached": false,
  "elapsedMs": 5678,
  "sido": { "code": "7", "name": "대구/경북" },
  "checkin": "20260805", "checkout": "20260806", "nights": 1, "nofpr": 2,
  "reached": true,                 // NetFunnel 통과 성공 여부
  "totalCount": 29,
  "availableCount": 10,
  "forests": [
    { "name": "(강릉시)대관령자연휴양림", "type": "국립", "status": "예약가능",
      "available": true, "rooms": 36, "openYear": 1989, "isNew": false }
  ]
}
```
> `openYear`(개장연도)·`isNew`(개장 3년 이내, `NEW_WITHIN_YEARS` 로 조정) 는
> **국립 휴양림 47곳에만** 채워진다(`data/national-open-years.json` 기준).
> 공립·사립, 그리고 지방산림청 관리 국유림(예: 진부령)은 `openYear:null / isNew:false`.
>
> 같은 (날짜·시도·인원) 재조회는 5분간 캐시되어 즉시(0ms) 반환된다.
> **주의:** 토·일·공휴일 전날 숙박은 선착순이 아니라 **추첨** 대상이라
> 선착순 조회(`/available`)에선 `예약불가`로 나온다(정상). 평일 날짜로 확인할 것.

## 세션 재사용 + 병렬 + 웹페이지 (권장 운영 흐름)

원격/빠른 운영을 위해 로그인 세션을 저장하고 재사용한다.

```bash
# ① (사용자, 세션 만료 시에만) 로그인 세션 저장
node src/poc.js login-save            # → auth.json  (또는 login-save.cmd 더블클릭)

# ② (재로그인 없이) 전국 객실 예약+대기 병렬 스캔
CONCURRENCY=6 node src/poc.js scan-nation 20260801 20260802 2   # ~5-7분

# ③ 결과 → 자체완결 웹 대시보드
node build-page.js                    # → artifacts/page.html  (Artifact 로 발행)
```

- `scan-nation` 은 `auth.json`(세션쿠키)을 재사용하므로 **비밀번호 입력 없이** 실행된다(로그인은 ①에서 1회).
- 각 휴양림에서 **예약(01) + 대기(02, `fn_wtng_goSrch`)** 를 모두 조회. 대기순번은 `.opt4`("2순위").
- 결과 행: `시도·휴양림·개관연도·신축·숙박시설·시설상세·예약가능여부·대기순위`.

## 진행 상황 / 다음 할 일

- [x] 결과 DOM 파서 확정 (`availability.js` `.rc_item`, `goods.js` `.list_box`)
- [x] `GET /available` REST API (휴양림 단위) + 국립 `openYear`/`isNew`
- [x] 로그인(`login.js`) + 객실 단위 조회(`goods.js` `extractRooms`) 확정
- [x] 대기 모드(`includeWait`) + 대기순위(`.opt4`)
- [x] 세션 저장/재사용(`login-save`, `auth.json`) + 병렬 스캔(`scan-nation`)
- [x] 전국 스캔 → 웹 대시보드(`build-page.js`) → Artifact 발행
- [ ] REST 서버에 객실 단위+세션 재사용 통합 (현재 /available은 휴양림 단위)
- [ ] 영구 저장(SQLite) + 주기 스캔 스케줄러
- [ ] 선착순/추첨 구분 필드(`hldtList`), goods 페이지네이션(>10방)
- [ ] 안드로이드 앱(REST 클라이언트)

> 자세한 인수인계·오류이력은 **[인수인계.md](./인수인계.md)** 참고.

## 주의

- "조회·안내"까지만. 자동예약·매크로는 하지 않는다.
- 수집 주기는 과도하지 않게(사이트 부하 배려).
- 내부 엔드포인트는 비공식 → 사이트 개편 시 깨질 수 있음(유지보수 필요).
