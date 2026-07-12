# Google Antigravity (AGY) 지침(Rules) 및 설정(Settings) 구성 가이드

Google Antigravity(AGY)는 AI 에이전트의 작동 방식과 개발 규칙을 사용자 맞춤형으로 설정할 수 있는 지침(Rules) 및 설정(Settings) 시스템을 지원합니다. 이 가이드는 이를 쉽게 설정하고 사용할 수 있도록 정리한 문서입니다.

---

## 1. 지침 및 설정의 위치 (어디서 설정하나요?)

### ① 전역(Global) 범위
모든 프로젝트 및 워크스페이스에 공통으로 적용되는 지침과 설정입니다.

*   **전역 에이전트 지침 (`GEMINI.md`)**:
    *   **경로**: `~/.gemini/GEMINI.md` (Windows: `C:\Users\<사용자명>\.gemini\GEMINI.md`)
    *   **역할**: 에이전트에게 항상 적용할 나만의 코딩 스타일, 답변 언어 선호도 등의 기본 규칙을 지정합니다.
*   **전역 CLI 설정 (`settings.json`)**:
    *   **경로**: `~/.gemini/antigravity-cli/settings.json`
    *   **역할**: API 키, 기본 사용 모델, 로그 수준, 도구 승인 권한 등을 제어합니다.
*   **전역 MCP 설정 (`mcp_config.json`)**:
    *   **경로**: `~/.gemini/antigravity-cli/mcp_config.json`
    *   **역할**: 모든 작업 공간에서 사용할 전역 Model Context Protocol(MCP) 서버를 정의합니다.

---

### ② 프로젝트/워크스페이스(Project/Workspace) 범위
해당 프로젝트 폴더에서 작업할 때만 적용되는 지침과 설정입니다.

*   **프로젝트 루트 지침 (`GEMINI.md`)**:
    *   **경로**: 프로젝트의 루트 디렉토리 (예: `[프로젝트_루트]/GEMINI.md`)
    *   **역할**: 해당 프로젝트의 기술 스택, 빌드/테스트 명령어, 디렉토리 구조 등을 기재합니다. 에이전트 시작 시 자동으로 로드됩니다.
*   **워크스페이스 룰 디렉토리 (`.agents/rules/`)**:
    *   **경로**: `[프로젝트_루트]/.agents/rules/` (이전 버전의 경우 `.agent/rules/`도 지원)
    *   **역할**: 규칙을 여러 개의 마크다운(`.md`) 파일로 모듈화하여 관리할 수 있습니다.
*   **프로젝트 MCP 설정 (`.agents/mcp_config.json`)**:
    *   **경로**: `[프로젝트_루트]/.agents/mcp_config.json`
    *   **역할**: 해당 프로젝트 내에서만 활성화할 로컬 MCP 서버를 지정합니다.

---

## 2. 지침(Rules) 작성 방법 및 형식

지침 파일(`GEMINI.md` 및 `.agents/rules/*.md`)은 **마크다운(Markdown)** 형식으로 자유롭게 작성합니다.

`.agents/rules/` 내의 파일들은 파일 최상단에 **Frontmatter**를 선언하여 활성화 방식(Trigger)을 제어할 수 있습니다.

### Frontmatter 선언 예시 (예: `.agents/rules/react-style.md`)
```markdown
---
name: React Coding Style
description: React 컴포넌트 개발 시 따라야 할 규칙
globs: ["src/components/**/*.tsx", "src/hooks/**/*.ts"]
trigger: "model" # always, model, manual 중 선택
---

# React 개발 규칙
- 함수형 컴포넌트는 선언식(`function`) 대신 화살표 함수(`const App = () => {}`)를 사용한다.
- UI 로직과 비즈니스 로직(Custom Hooks)을 철저히 분리한다.
```

*   **`always`**: 에이전트와의 모든 대화에 항상 이 지침을 적용합니다.
*   **`model`**: 에이전트가 질문 내용이나 변경 파일을 감지하여 지침을 로드할지 스스로 결정합니다.
*   **`glob`**: `globs`에 지정된 파일 패턴을 수정하거나 참고할 때만 자동으로 지침이 로드됩니다.
*   **`manual`**: 사용자가 직접 `@react-style`과 같이 멘션했을 때만 활성화됩니다.

---

## 3. 현실적인 지침 작성 예시 (바로 적용 가능)

### 💡 전역 `GEMINI.md` 예시 (`~/.gemini/GEMINI.md`)
> 에이전트에게 늘 요구하고 싶은 나의 개인 취향
```markdown
# 나의 기본 개발 규칙

- 답변은 친절한 인사말을 생략하고, 핵심 코드와 해결법 위주로 짧고 간결하게 작성해줘.
- 코드를 변경할 때는 변경된 부위만 보여주는 Diff 포맷을 사용해줘.
- 질문 답변과 코드 내의 모든 주석은 한국어로 작성해줘.
- 항상 명시적인 에러 처리(`try-catch` 및 예외 던지기)를 포함해줘.
```

### 💡 프로젝트 루트 `GEMINI.md` 예시 (`[Project Root]/GEMINI.md`)
> 프로젝트의 고유 기술 스택 및 작업 표준
```markdown
# 프로젝트 규칙 (TypeScript API Server)

## 기술 스택
- Core: Node.js (v20+), Fastify, TypeScript
- ORM: Prisma
- Test: Vitest

## 디렉토리 규칙
- API 라우팅 정의는 `/src/routes/` 폴더 하위에 위치한다.
- 실제 비즈니스 로직은 `/src/services/` 폴더 하위에 위치한다.

## 빌드 및 검증 명령어
- 빌드: `npm run build`
- 테스트 실행: `npm run test`
- 린트 검사: `npm run lint`

## 개발 수칙
- 새로운 엔드포인트를 구현할 때는 그에 매칭되는 `*.test.ts` 파일을 `tests/` 폴더에 작성해야 한다.
- 외부 의존성(npm 패키지)을 추가해야 할 때는 사용자에게 먼저 승인을 구한다.
```

---

## 4. 유용한 팁 & 명령
*   **UI에서 관리하기**:
    *   에이전트 패널 오른쪽 위의 더보기 버튼(**`...`**) -> **Customizations (사용자 정의)** -> **Rules (지침)** 탭을 통해 간편하게 글로벌 및 프로젝트 지침 파일을 생성하고 편집할 수 있습니다.
*   **적용 상태 확인하기**:
    *   채팅창에 **`/memory`** 또는 **`/memory show`** 명령어를 전송하면, 현재 에이전트가 참조하고 있는 모든 `GEMINI.md` 파일과 활성화된 규칙 파일 리스트를 직접 조회할 수 있습니다.
