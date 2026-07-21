# 작업분해 — Phase 0+1 (1차 릴리스) — 숲나들e 알림 앱

> 코딩 세션 착수용 체크리스트. 의존성·순서 포함. `[B]`=백엔드 `[A]`=앱 `[O]`=운영/설정 `[R]`=조사.
> 근거: `앱기획설계서.md`, `API계약.md`, `DB스키마.md`, `docs/adr/0001~0006`, `CONTEXT.md`.

---

## Phase 0 — 기반

### 0.1 조사(먼저 해소해야 설계 확정)
- [x] `[R]` **딥링크 타깃 확정(2026-07-22 완료).** 결론: 공식 앱은 WebView 래퍼 + **App Links
      미선언(assetlinks.json 404)** + goods는 NetFunnel 게이트 → **방/날짜 프리필 딥링크 불가**.
      → 확정 경로: `ACTION_VIEW`로 `fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001`(선착순 검색 진입,
      게이트 없음) 착지 + **핸드오프 카드가 검색값(휴양림·날짜·인원·상태) 표기**로 대체. 자동입력 없음. (설계서 §6)
      → Phase 1 잔여 태스크: `[A]` 기기 테스트 "https 링크 탭 시 숲나들e 앱 선택창 노출 여부"만 관찰(폴리시).
- [x] `[R]` **goods 페이지네이션 확정(2026-07-22 완료).** 결론: 예약·대기 각 모드가 `fn_goPage`로
      페이지네이션(저장 DOM `goods-wtng.html`에 `paging_count "(1/3)"` 실재), 현 파서는 1페이지만 읽어
      combined ~20 truncate(rooms-region.json 20-상한 확증). → 확정: **각 모드 전 페이지 순회**
      (`.paging_count`에서 N 읽고 `fn_goPage('2')…('N')` 구동, `goodsId` dedup 누적). 내부 AJAX는
      `/rep/or/sssn/innerFcfsRsrvtPssblGoodsDetls.do`. (설계서 §6-bis)
      → Phase 1 구현 태스크는 §1.1로 편입.
- [ ] `[R]` 세션 유효기간·자동 재로그인 신뢰성 실측(만료 감지 신호, 백오프 값).
- [ ] `[R]` **레이트버짓 안전값 실측(ADR-0006 `R`):** 단일 계정 지속 호출의 무잠금·무소프트밴 상한(req/min)을 보수적으로 측정.
- [ ] `[R]` **min-nofpr 폴 병합 가능성(ADR-0006 §4):** 사이트 가용성이 순수 `capacity` 필터인지 nofpr별 별도 규칙인지 실측. 순수 capacity면 poll_target을 인원 무관 1회 폴로 병합.

### 0.2 백엔드 서비스화
- [ ] `[B]` SQLite 도입 + 스키마 마이그레이션(`DB스키마.md`). `cache.js` 인메모리 → DB 승격.
- [ ] `[B]` 자격증명 암호화 저장 모듈(키 관리: OS 시크릿/환경 밖). 평문 로깅 금지 가드.
- [ ] `[B]` `login.js` → **세션 확보 + 만료 감지 + 자동 재로그인**(5회 잠금 회피: 실패 시 무재시도+알림).
- [ ] `[B]` 스케줄러 스켈레톤: `poll_target` 큐 + 적응형 주기 + **전역 레이트버짓(R req/min, ADR-0006)**
      + 워커풀(기존 CONCURRENCY 흡수). 지금은 빈 큐라도 루프 동작.
- [ ] `[B]` **레이트버짓·백프레셔(ADR-0006):** `R`에서 커버리지 상한 `N_max` 산출, 예산 부족 시
      urgent>normal 우선 소비, 굶는 target은 상태로 노출(침묵 금지).
- [ ] `[B]` **poll_target reaper/reconciliation(M3):** 감시 삭제·일시정지·날짜경과·D-2 종료 시 고아
      target 비활성화, 감시→target 주기 재파생·병합.
- [ ] `[B]` **스캔 건전성 모니터(M5):** `scan.ok` 연속실패·성공률 임계 → 소유자 푸시(소프트밴/세션사망 조기감지).
- [ ] `[B]` 수집계층 계약 격리: `availability`/`goods`/`catalog` 반환형을 API/DB 필드에 매핑하는 어댑터.
      **상태값을 API §6 표준 enum으로 정규화**(M2, 사이트 표시문구 변경 격리).

### 0.3 REST API 골격 (`API계약.md`)
- [ ] `[B]` **Bearer 토큰 미들웨어(ADR-0005):** 모든 `/v1/*` 토큰 검증·`401` 처리. 무인증 fallback 없음.
- [ ] `[B]` `/v1/health`, `/v1/sido`, `/v1/forests`, `/v1/forests/{id}/calendar`(선착순/추첨/휴무 파생).
- [ ] `[B]` `/v1/auth/forest-login`, `/v1/auth/status`, `DELETE`.
- [ ] `[B]` `/v1/devices` (등록/PATCH).

### 0.4 인그레스·FCM·앱 스캐폴딩
- [ ] `[O]` **인그레스 터널(ADR-0005):** Cloudflare Tunnel/Tailscale로 백엔드 노출(인바운드 포트 0, TLS 내장).
- [ ] `[O]`/`[A]` **앱 토큰 발급·검증:** 최초 셋업 시 Bearer 토큰 발급 → 앱 보관 → 전 요청 첨부.
- [ ] `[O]` **Firebase 프로젝트 생성**(사용자 액션) + 서버 키/서비스계정. 백엔드 FCM Admin SDK 연결.
- [ ] `[A]` Kotlin+Compose 프로젝트 생성, 네트워킹(Retrofit 등), FCM 수신, 알림 채널 2종(긴급/일반) 등록.
- [ ] `[A]` 숲나들e 로그인 화면 → `/v1/auth/forest-login` → 세션토큰 보관(비번 미저장).

---

## Phase 1 — 핵심 루프

### 1.1 전국 조회 (스냅샷 + 탭 실시간)
- [ ] `[B]` `GET /v1/search`: 스냅샷 집계에서 예약가능/대기가능 요약 반환. **신선도 2차원 분리(H3, API §3):**
      `reservable`은 `forest_availability`(광역 신선, `availSnapshotAt`), `waitable`은 `room_state`
      집계이되 **감시 target만 warm**(`waitCovered`/`waitSnapshotAt`, 미감시는 null). 부족 차원만 백그라운드 큐잉.
- [ ] `[B]` `POST /v1/search/refresh`(백그라운드 잡).
- [ ] `[B]` **`goods.searchForestGoods` 페이지네이션 순회 추가**(§6-bis): 예약·대기 각 모드에서
      `.paging_count` N 읽고 `fn_goPage('2')…('N')` 구동, 페이지마다 `extractRooms()` 누적·dedup.
      **숙소상세 감시 신뢰성의 전제** — 감시/스냅샷/온디맨드 모두 이 순회를 통과해야 함.
- [ ] `[B]` `GET /v1/forests/{id}/rooms`: 온디맨드 실시간(위 순회 반영). `pagesTraversed`/`complete` 반환.
- [ ] `[A]` 조회 화면: 날짜/인원/시도 선택 → 결과 리스트(신선도 표시) → 휴양림 탭 → 방 리스트.
- [ ] `[A]` 필터/정렬: 신축·시설분류·인원·예약가능 우선.
- [ ] `[A]` 추첨/선착순/휴무 배지 + 안내문(calendar 기반).

### 1.2 감시 등록·관리
- [ ] `[B]` `POST/GET/PATCH/DELETE /v1/watches` + `GET /v1/watches/{id}` + `/events`.
      (희망기간·요일필터는 계약만, 동작은 Phase 2). `wait_deadline`(D-2) 계산.
- [ ] `[B]` 감시 → `poll_target` 파생·병합((휴양림,날짜,인원) 유니크).
- [ ] `[A]` 방 리스트/휴양림에서 "감시 추가"(숙소상세/휴양림 아무방이나). 감시 목록 화면(상태·순위·D-2).

### 1.3 폴링·판정·알림
- [ ] `[B]` 스케줄러 실동작: `poll_target` 소비 → `goods`(includeWait) 조회 → `scan`/`room_state` 적재.
- [ ] `[B]` 적응형 주기: **외생 prior 우선(M4)** — D-day 근접·추첨 전날·시간대로 축소/확대. 취소多
      (watch_event)는 폴링 산물이라 hot 구간을 놓칠 수 있어 보조 신호로만(학습형은 Phase 3).
- [ ] `[B]` 상태 전이 판정: 직전 `room_state` 대비 opened/closed/rank_changed → `watch_event`.
- [ ] `[B]` 감시 매칭: 전이가 감시 조건(대상·등급) 충족 시 알림 후보. 재알림 스로틀 + DND(긴급 관통).
- [ ] `[B]` FCM 발송 + `notification` 로그. 페이로드에 딥링크·날짜·상태.
- [ ] `[A]` 알림 수신 → 2등급 표시(예약가능=풀스크린/소리, 대기=일반) → 탭 시 딥링크 핸드오프.
- [ ] `[A]` DND 설정 화면(시간대, 긴급 관통 토글, 순위개선 알림 토글).

### 1.4 기본 차별화
- [ ] `[A/B]` D-2 카운트다운 경보(대기감시). `[A/B]` 핸드오프 카드(가격·인원·면적·신축배지+딥링크).
- [ ] `[B]` 추첨/선착순 구분은 §1.1 calendar 재사용.

---

## 검증 (릴리스 게이트)
- [ ] `[B]` 파서 회귀 테스트: `availability`/`goods` 셀렉터가 라이브에서 정상(사이트 개편 감지).
- [ ] `[B]` 레이트버짓 하에서 지속 폴링 24h — 세션에러/계정잠금 0 확인(보수적 주기부터).
- [ ] `[B→A]` 실제 취소표 1건에 대해 감지→푸시→핸드오프 **엔드투엔드** 성공.
- [ ] `[O]` 원격 머신 워치독(프로세스 죽으면 재기동), 24/7 가동 점검.
- [ ] `[B]` 자동 재로그인: 세션 강제만료 후 폴링이 스스로 복구되는지.
- [ ] `[B]` 커버리지 상한 표면화: 활성 `poll_target`이 `N_max` 근접 시 API가 저하 신호(ADR-0006).
- [ ] `[O]` 인그레스 터널 + Bearer: **LAN 밖 실기기**에서 TLS 접속·`401` 동작 확인(ADR-0005).

---

## 명시적 비범위(이번 릴리스)
- 희망기간 실동작·유연 날짜 히트맵(Phase 2)
- 취소표 패턴·명당시간·대기 성공확률(Phase 3, 단 **이력 적재는 Phase 1부터**)
- 광역 조건 감시·멀티유저·클라우드 이전(Phase 4)
- iOS

## 사용자(소유자) 액션 필요
- Firebase 프로젝트 생성/키 발급
- 원격 Windows 머신 24/7 가동 보장(전원·네트워크)
- 앱에서 숲나들e 최초 로그인 1회
