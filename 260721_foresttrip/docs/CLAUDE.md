# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 개요

숲나들e(foresttrip.go.kr)에서 **날짜 + 시/도**로 예약/대기 가능한 전국 자연휴양림·객실을 조회하는
Node.js ESM 스크래퍼(PoC). 향후 **안드로이드 알림 앱의 백엔드**가 되며, 그 앱의 확정 설계·용어집·
ADR은 `01_설계/`에 있다(코딩 착수 전 반드시 참고). 공식 API가 아니라 사이트 내부 엔드포인트를
Playwright로 다루므로 사이트 개편 시 깨질 수 있는 비공식 통합이다.

## 셋업 · 실행

```bash
npm install
npx playwright install chromium        # Playwright는 최초 1회 브라우저 설치 필요
```

- **Node 20.6+ 필수** — `process.loadEnvFile()`로 루트 `.env`를 로드한다(`type: module` ESM).
- 자격증명: 루트 `.env`에 `ID` / `PW`(또는 `FOREST_ID`/`FOREST_PW`). `.gitignore`로 커밋 제외.
- **파서 회귀 테스트 있음**(`02_구현/`): `npm test`(오프라인, `test/fixtures/` 저장 DOM에 실제
  파서를 돌려 스냅샷·구조 검증, 무네트워크·결정적) / `npm run test:live`(라이브 셀렉터 헬스체크,
  사이트 개편 감지 — 세션만료·재고없음은 SKIP, 실제 셀렉터 깨짐만 FAIL) / `npm run test:fixtures`
  (`artifacts/` 저장 DOM → PII 제거 fragment 로 fixture 재생성). 백엔드 서비스 로직 검증은 별도.

### 명령 (CLI: `node src/poc.js <cmd>`)

| 명령 | 게이트 | 설명 |
|---|---|---|
| `catalog [시도]` | 없음 | 시/도·휴양림목록·달력 메타(브라우저 불필요) |
| `search <시도> <입실> <퇴실> [인원]` | NetFunnel | 지역 예약가능 휴양림 목록 |
| `rooms <시도> <insttId> <입실> <퇴실> [인원]` | NetFunnel+로그인 | 단일 휴양림 객실(예약+대기) |
| `rooms-region <시도> <입실> <퇴실> [인원]` | NetFunnel+로그인 | 지역 전체 객실(순차, 느림) |
| `rooms-nation <입실> <퇴실> [인원]` | NetFunnel+로그인 | 전국 객실(순차, 매우 느림) |
| `login-save` | 로그인 | `.env`로 로그인 → 세션을 `auth.json`에 저장 |
| `scan-nation <입실> <퇴실> [인원]` | 세션재사용 | **auth.json 재사용 + 병렬** 전국 스캔(권장) |

- npm 스크립트: `npm run serve`(REST 서버), `npm run collect`(국립 개관연도 수집), `npm run catalog/search`.
- `node build-page.js` → `artifacts/rooms-region.json`을 자체완결 HTML 대시보드(`artifacts/page.html`)로.
- 날짜는 `YYYYMMDD`. 시도코드: 1=서울/인천/경기 2=강원 3=충북 4=대전/충남 5=전북 6=전남광주 7=대구/경북 8=부산/경남 9=제주.

### 환경변수
- `HEADLESS=1` — 창 없이 실행. **미지정 시 headful**(창이 보이고 `slowMo=150`). `rooms*`/`scan-nation`은
  미지정 시 자동으로 `HEADLESS=1` 설정.
- `CONCURRENCY` — `scan-nation` 병렬 워커 수(기본 5, 권장 6).
- `PORT` — REST 서버 포트(기본 3000).

## 아키텍처 — 3단계 접근 장벽 (핵심)

조회 깊이에 따라 장벽이 다르며, **이 구분이 코드 구조 전체를 지배한다.**

1. **장벽 없음 (순수 HTTP)** — 시/도·휴양림목록·휴양림달력. `session.js`가 예약 메인 페이지에서
   세션쿠키+`_csrf`를 뽑고, `ajaxGet`이 `X-Ajax-call: true` 헤더로 JSON 엔드포인트를 친다. `catalog.js`.
2. **NetFunnel 게이트 (가상대기열)** — 예약가능 잔여 조회. `curl`로 직접 치면 302→`/com/alert.do`로
   바운스. **Playwright로 실제 페이지를 띄워** 사이트 검색함수 `fn_top_goSearch()`를 호출하면
   `netfunnel_key`가 정상 발급되어 통과한다. `availability.js`(휴양림 단위).
3. **NetFunnel + 로그인** — 객실(숙소상세) 단위. `login.js`가 `.env`로 로그인한 컨텍스트를 만들고
   `goods.js`가 그 컨텍스트를 재사용해 `fcfsRsrvtPssblGoodsDetls.do`를 파싱한다. 비로그인 시 로그인화면 반환.

### 예약(01) vs 대기(02) — 두 번 조회해야 완전하다
- 기본 검색(`rsrvtWtngSctin=01`)은 **예약가능만** 보여준다. 주말·공휴일 전날 숙박은 추첨이라 여기서 안 뜬다.
- 대기 물량은 goods 페이지에서 `fn_wtng_goSrch()`(=02)를 호출해 **재조회**해야 나온다(`goods.js`의
  `includeWait`). 대기순위는 `.list_box .opt4`("2순위"). 대기신청은 숙박일 **D-2 마감**.

### 세션 재사용 운영 모델 (원격·병렬)
`login-save`(사용자가 1회, 비밀번호 입력) → `ctx.storageState()` → `auth.json` → 이후 `scan-nation`이
**재로그인 없이** 세션 재사용 + 워커풀 병렬(순차 ~35분 → 병렬 ~5–7분). 세션 재사용은 비밀번호 입력이
아니므로 어시스턴트가 직접 실행 가능하다.

### 데이터 정규화
- `openYear.js` — 국립 47곳만 개관연도/신축(`data/national-open-years.json`, 이름 매칭 + 별칭 보정).
  공립·사립·지방청 국유림은 `null`.
- `browser.js` — Chromium 싱글턴(요청마다 컨텍스트만 새로). `cache.js` — 인메모리 TTL 캐시(서버용).

## 비공식 계약 (개편 시 여기부터 깨진다)
- **엔드포인트**: `src/constants.js`의 `ENDPOINTS`(사이트 인라인 JS 분석으로 확인).
- **파서 셀렉터**: 휴양림 단위 `availability.js`의 `.rc_item`, 객실 단위 `goods.js`의
  `.goods_list_area .list_box`(`.opt1` 숙박시설+방이름, `.opt2` 인원/면적, `.opt3` 가격, `.opt4` 대기순위,
  `.item[data-value]` goodsId, `.btn_group .defBtn`의 `.txtRsrvt`/`.txtWtng` display로 상태).

## 반드시 아는 함정 (실제로 겪고 고친 것)
- **비밀번호는 어시스턴트가 대신 입력 불가**(안전 규칙). 최초 로그인은 사용자가 `login-save.cmd`로.
  이후 `auth.json` 재사용 스캔은 어시스턴트가 실행 가능. **로그인 5회 실패 시 계정 잠금 → 실패 시 재시도 금지.**
- **`.cmd`는 순수 ASCII로 작성, `chcp` 금지.** UTF-8 전환 + 한글 주석이 있으면 cmd가 바이트 오프셋을
  잘못 읽어 `0111`의 `11`을 명령으로 실행하는 식으로 깨진다(`'11'은(는) ... 명령이 아닙니다`).
- **`!`(Claude Code 프리픽스) 명령은 이 프로젝트 머신에서 실행되지 않는다** — 사용자가 원격 데스크톱에서
  `.cmd` 더블클릭으로 실행.
- **top-level await로 호출하는 함수가 참조하는 `const`는 호출문보다 위에 선언**(TDZ: `Cannot access 'X'
  before initialization`).
- **goods 페이지네이션 미처리(확정 버그)**: 현 `extractRooms()`는 로드된 **1페이지만** 파싱한다. goods는
  각 모드가 `fn_goPage('2')…('N')`로 페이지네이션되며(`.paging_count "(1/N)"`), 대형 휴양림은 방이
  누락된다(combined ~20에서 truncate). 앱에선 **각 모드 전 페이지 순회**가 필수(`01_설계` §6-bis).

## 관련 문서
- `01_설계/` — **앱 설계 확정본**: `앱기획설계서.md`(우산), `CONTEXT.md`(용어집), `API계약.md`,
  `DB스키마.md`, `작업분해_Phase0-1.md`, `docs/adr/0001~0006`.
- `인수인계.md` — 인수인계 + 오류이력, `코드설계서.md` — 아키텍처, `조사보고서.md` — 데이터소스/게이트 실측.
