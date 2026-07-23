# 폰에서 "NAS에 저장해" 한마디로 대화를 저장하기 — 시놀로지 MCP 설정 가이드



> 스마트폰 Claude 앱에서 **"이 대화 정리해서 NAS에 저장해"** 라고 말하면,

> AI가 대화를 마크다운(.md)으로 정리해 **시놀로지 NAS의 지정 폴더**에 저장하도록 만드는 전체 설정서입니다.

> 구성: **DDNS + 역방향 프록시(HTTPS) + Google OAuth 인증** (정석·보안 강함).



---



## 0. 이 문서가 만드는 것 / 최종 사용 모습



- 시놀로지에 **작은 MCP 서버**(도구 1개: `save_markdown`)를 Docker로 띄웁니다.

- 이 서버를 **HTTPS로 외부 공개**하고, **Google 계정 로그인(OAuth)** 으로 보호합니다.

- claude.ai(폰/웹)에 **커스텀 커넥터**로 등록합니다.

- 이후 폰에서 **"NAS에 저장해"** 라고 하면 Claude가 `save_markdown` 도구를 호출 → NAS 폴더에 `.md`가 생깁니다.



```

[폰의 Claude 앱]  "이 대화 정리해서 NAS에 저장해"

      │

      ▼

 claude.ai (커스텀 커넥터)

      │  HTTPS + Google OAuth

      ▼

[시놀로지] 역방향 프록시 (HTTPS 종단, notes.내DDNS)

      │

      ▼

[Docker 컨테이너] MCP 서버  ── 도구: save_markdown(title, content)

      │

      ▼

  /volume1/notes/20260703_1530_시놀로지_MCP_설계.md   ← 실제 저장

```



---



## 1. 준비물 & 채워야 할 값



### 준비물 체크

- [ ] 시놀로지 NAS + **Container Manager(Docker)** 설치 가능

- [ ] 인터넷 공유기 **관리자 접근**(포트포워딩 설정용)

- [ ] **시놀로지 DDNS** 주소 (예: `mynas.synology.me`) — DSM에서 무료 발급 가능

- [ ] **Google 계정** (OAuth 로그인용)

- [ ] **Claude Pro/Max/Team** 플랜 (커스텀 커넥터 필수) ✅ 확인됨



### 진행 전에 정해둘 값 (빈칸을 채우면서 진행하세요)



| 항목 | 예시 | 당신의 값 |

| --- | --- | --- |

| 공개 호스트명(DDNS 서브도메인) | `notes.mynas.synology.me` | ________________ |

| NAS 저장 폴더(공유폴더 실제 경로) | `/volume1/notes` | ________________ |

| Google 계정 이메일 | `jalansight@gmail.com` | ________________ |

| 서버 내부 포트 | `8000` | 8000 (그대로 권장) |



> 💡 호스트명은 `내DDNS주소` 앞에 `notes.` 같은 서브도메인을 붙인 형태를 권장합니다.

> 시놀로지 DDNS는 서브도메인 와일드카드를 지원하므로 `notes.mynas.synology.me`가 그대로 동작합니다.



---



## 2. [1단계] 프로젝트 파일 준비



이 가이드 옆의 **`nas-notes-mcp/`** 폴더에 필요한 코드가 이미 만들어져 있습니다. 폴더째 NAS로 옮기세요.



```

nas-notes-mcp/

├─ server.py            # MCP 서버 본체 (도구 1개 + Google OAuth)

├─ requirements.txt     # 파이썬 의존성 (fastmcp)

├─ Dockerfile           # 컨테이너 이미지 정의

├─ docker-compose.yml   # 실행 설정 (볼륨/포트/env)

└─ .env.example         # 비밀값 템플릿 → 복사해서 .env 로

```



### 2-1. `.env` 만들기

`nas-notes-mcp/` 안에서 `.env.example`을 복사해 `.env`로 만들고 값을 채웁니다.

(Google 값은 **3단계**에서 발급받아 채웁니다. 일단 나머지부터.)



```env

PUBLIC_BASE_URL=https://notes.여기당신DDNS.synology.me

GOOGLE_CLIENT_ID=(3단계에서 채움)

GOOGLE_CLIENT_SECRET=(3단계에서 채움)

NOTES_DIR=/data/notes

# ALLOWED_EMAILS=jalansight@gmail.com   # (선택) 내 계정만 허용하려면 주석 해제

```



### 2-2. 저장 폴더 경로 맞추기

`docker-compose.yml`의 볼륨 좌측을 실제 NAS 폴더로 바꿉니다.



```yaml

    volumes:

      - /volume1/notes:/data/notes   # 좌측 = NAS 실제 경로, 우측 = 컨테이너 내부 경로

```


fGF
> `/volume1/notes` 부분만 본인 공유폴더 경로로 바꾸면 됩니다. 우측(`/data/notes`)은 그대로 두세요

> (`.env`의 `NOTES_DIR`과 일치해야 합니다).



<details>

<summary>참고: server.py 핵심(도구 정의) — 이미 파일로 제공됨</summary>



```python

@mcp.tool

def save_markdown(title: str, content: str) -> str:

    """대화 정리 내용을 마크다운(.md) 파일로 NAS 폴더에 저장한다."""

    ts = datetime.now().strftime("%Y%m%d_%H%M")

    filename = f"{ts}_{_safe_slug(title)}.md"

    path = NOTES_DIR / filename

    path.write_text(content, encoding="utf-8")

    return f"저장 완료: {filename} ({len(content)}자)"

```

파일명은 자동으로 `날짜_시간_제목.md` 형태가 되고, 위험 문자는 제거됩니다(경로 탈출 방지).

</details>



---



## 3. [2단계] Google OAuth 클라이언트 발급



커넥터가 이 서버에 붙을 때 **Google 로그인**을 거치게 하기 위한 준비입니다.



1. **Google Cloud Console** 접속 → <https://console.cloud.google.com>

2. 상단에서 **새 프로젝트** 생성 (이름 예: `nas-notes`).

3. 좌측 메뉴 **API 및 서비스 → OAuth 동의 화면**

   - User Type: **External** 선택 → 만들기

   - 앱 이름/사용자 지원 이메일/개발자 연락처에 **본인 이메일** 입력

   - **테스트 사용자(Test users)** 에 본인 Google 이메일 추가 (게시 안 해도 본인은 사용 가능)

4. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**

   - 애플리케이션 유형: **웹 애플리케이션**

   - **승인된 리디렉션 URI** 추가:

     ```

     https://notes.여기당신DDNS.synology.me/auth/callback

     ```

     > ⚠️ 콜백 경로(`/auth/callback`)는 FastMCP 버전에 따라 다를 수 있습니다.

     > **5단계에서 서버를 처음 켜면 로그에 실제 콜백 URL이 출력**되니, 그 값을 그대로 여기에 등록하는 게 가장 확실합니다.

     > (지금은 위 예시로 넣어두고, 로그 확인 후 필요하면 수정.)

5. 생성되면 **클라이언트 ID / 클라이언트 보안 비밀**이 나옵니다 → `.env`의

   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`에 붙여넣기.



---



## 4. [3단계] 시놀로지에서 컨테이너 실행



### 4-1. 파일 업로드

`File Station`으로 `nas-notes-mcp/` 폴더를 NAS 임의 위치(예: `/volume1/docker/nas-notes-mcp`)에 업로드합니다. `.env`도 채워서 함께.



### 4-2. Container Manager로 실행

1. **Container Manager → 프로젝트 → 생성**

2. 프로젝트 이름: `nas-notes-mcp`

3. 경로: 방금 업로드한 폴더 지정

4. 소스: **docker-compose.yml 사용** 자동 인식

5. **빌드/시작**



### 4-3. 정상 기동 확인

- 컨테이너 **로그** 탭을 엽니다.

- `Uvicorn running on http://0.0.0.0:8000` 또는 유사 메시지가 보이면 OK.

- 로그에 **OAuth 콜백 URL**이 찍혀 있으면, 그 값을 **3단계 4번의 리디렉션 URI**와 일치시키세요(다르면 Google 콘솔에서 수정).



> 내부망 확인: 같은 네트워크 PC 브라우저에서 `http://시놀로지IP:8000/mcp/` 접속 시

> 인증 요구(401) 또는 MCP 응답이 오면 서버는 살아있는 것입니다.



---



## 5. [4단계] HTTPS로 외부 공개 (DDNS·인증서·역방향 프록시)



### 5-1. DDNS 설정

DSM → **제어판 → 외부 액세스 → DDNS → 추가**

- 서비스 공급자: **Synology**

- 호스트명: `mynas` (→ `mynas.synology.me`)



### 5-2. 공유기 포트포워딩

공유기 관리페이지에서 아래를 NAS 내부 IP로 포워딩:

- **443 → NAS 443** (HTTPS, 필수)

- **80 → NAS 80** (Let's Encrypt 인증서 발급/갱신용)



### 5-3. Let's Encrypt 인증서

DSM → **제어판 → 보안 → 인증서 → 추가 → Let's Encrypt**

- 도메인: `notes.mynas.synology.me` (실제 사용할 호스트명)

- 발급 후, 이 인증서를 아래 역방향 프록시에 적용.



### 5-4. 역방향 프록시 생성

DSM → **제어판 → 로그인 포털 → 고급 → 역방향 프록시 → 생성**



| 구분 | 프로토콜 | 호스트명 | 포트 |

| --- | --- | --- | --- |

| **소스** | HTTPS | `notes.mynas.synology.me` | 443 |

| **대상** | HTTP | `localhost` | 8000 |



- **사용자 지정 헤더** 탭 → **생성 → WebSocket** 프리셋 추가

  (스트리밍/SSE 연결이 끊기지 않도록 `Upgrade`/`Connection` 헤더 전달).



→ 이제 공개 엔드포인트가 생깁니다:

```

https://notes.mynas.synology.me/mcp/

```



> ✅ 브라우저에서 `https://notes.mynas.synology.me/mcp/` 접속 시 자물쇠(유효 인증서)가 보이고

> 인증을 요구하면 성공입니다.



---



## 6. [5단계] claude.ai에 커스텀 커넥터 등록



> 메뉴 명칭은 앱/웹 업데이트에 따라 조금씩 다를 수 있습니다.



### 웹(claude.ai)에서

1. **설정(Settings) → 커넥터(Connectors)** 이동

2. **커스텀 커넥터 추가(Add custom connector)**

3. 이름: `NAS 노트`, URL:

   ```

   https://notes.mynas.synology.me/mcp/

   ```

4. 저장하면 **OAuth 로그인 창**이 뜹니다 → **Google 계정으로 로그인 → 권한 허용**

5. 연결 성공 시 커넥터 목록에 `NAS 노트`가 나타나고, `save_markdown` 도구가 보입니다.



### 폰(Claude 앱)에서

- 앱 **설정 → 커넥터**에서 동일하게 추가하거나, 웹에서 등록한 커넥터가 계정 동기화로 나타납니다.



---



## 7. [6단계] "말하면 자동 저장" 만들기 (Project 지침)



매번 길게 설명하지 않도록, **Project**를 하나 만들고 커스텀 지침에 넣으세요.



1. claude.ai → **Projects → 새 프로젝트** (예: `NAS 메모`)

2. 프로젝트에서 **NAS 노트 커넥터를 활성화**

3. **커스텀 지침**에 붙여넣기:



```

사용자가 "저장", "NAS에 저장", "md로 정리해서 저장" 등으로 말하면,

직전까지의 대화를 읽기 좋은 마크다운으로 정리한 뒤 save_markdown 도구를 호출한다.

- title: 대화 주제를 요약한 짧은 한글 (파일명이 됨)

- content: 정리한 마크다운 본문 전체 (제목/요점/결론/코드블록 포함)

저장 후에는 생성된 파일명을 사용자에게 알려준다.

```



이제 이 프로젝트 안에서 대화하다가 **"이 대화 정리해서 NAS에 저장해"** 한마디면 끝입니다.



---



## 8. [7단계] 테스트



1. 프로젝트 안에서 아무 주제로 몇 마디 대화.

2. **"이 대화 정리해서 NAS에 저장해"** 입력.

3. Claude가 `save_markdown` 호출 → "저장 완료: 20260703_1530_….md" 회신.

4. NAS `File Station`에서 저장 폴더(`/volume1/notes`) 확인 → `.md` 파일 존재.



---



## 9. 문제 해결 (Troubleshooting)



| 증상 | 원인/해결 |

| --- | --- |

| 커넥터가 "연결 실패" | 역방향 프록시 대상 포트(8000)·호스트 확인, 컨테이너 실행 중인지 로그 확인 |

| 브라우저 인증서 경고 | Let's Encrypt 인증서가 그 호스트명에 발급/적용됐는지, 443/80 포워딩 확인 |

| OAuth "redirect_uri_mismatch" | Google 콘솔의 리디렉션 URI와 **서버 로그의 콜백 URL**이 정확히 일치해야 함(끝 슬래시까지) |

| `/mcp` 404 | 엔드포인트는 보통 `/mcp/`(끝 슬래시). 커넥터 URL을 `/mcp/`로 |

| 연결은 되는데 응답이 끊김 | 역방향 프록시 **WebSocket 사용자 지정 헤더** 추가했는지 확인 |

| 도구는 보이는데 저장 안 됨 | 볼륨 경로/권한 확인. 저장 폴더에 컨테이너 쓰기 권한이 있는지 |

| 도구가 대화에 안 뜸 | 그 대화(프로젝트)에서 커넥터가 **켜져 있는지** 확인 |

| Google 로그인에서 "앱이 확인되지 않음" | OAuth 동의화면 **테스트 사용자**에 본인 이메일 추가했는지 확인 |



---



## 10. 보안 체크리스트



- ⚠️ **기밀 대화 금지**: 이 경로로 저장하면 내용이 커넥터를 거쳐 나갑니다.

  **감사·규정·사내(예: ComplyMate) 대화에는 절대 쓰지 마세요.** 개인 메모 전용.

- **내 계정만 허용**: `.env`의 `ALLOWED_EMAILS`에 본인 이메일을 넣고 `server.py`의 허용목록 검사를 켜세요.

- **비밀값 관리**: `.env`(Client Secret 포함)는 공유/커밋 금지. NAS 폴더 권한 최소화.

- **커넥터는 필요할 때만 켜기**: 평소 대화에 도구 스키마가 안 실려 **토큰도 절약**됩니다.

- **저장 폴더 격리**: 시스템 폴더가 아닌 전용 공유폴더(`/volume1/notes`)만 마운트.

- **파일명 새니타이즈**: `save_markdown`이 경로 탈출/위험문자를 이미 차단합니다.



---



## 11. 참고 링크



- FastMCP 문서(인증 포함): <https://gofastmcp.com>

- Model Context Protocol: <https://modelcontextprotocol.io>

- Google Cloud Console: <https://console.cloud.google.com>

- 시놀로지 역방향 프록시/인증서: DSM 도움말 "제어판 → 로그인 포털 / 보안 → 인증서"



---



### 부록 A. 값 요약표 (완성 후 기록)



| 항목 | 최종 값 |

| --- | --- |

| 공개 URL | `https://______.synology.me/mcp/` |

| Google Client ID | `______.apps.googleusercontent.com` |

| 리디렉션 URI(콜백) | `https://______/auth/callback` |

| NAS 저장 폴더 | `/volume1/______` |

| 허용 이메일 | `______@gmail.com` |



*문서 생성: Claude Code · 구성: DDNS + 역방향 프록시 + Google OAuth*
