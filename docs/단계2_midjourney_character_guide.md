# 🎨 Midjourney 캐릭터 일관성 생성 가이드 (단계별 실전 매뉴얼)

유튜브 한국어 교육 쇼츠의 주인공이 될 3명의 캐릭터를 미드저니(Midjourney)에서 동일한 얼굴로 생성하고 일관성을 유지하는 단계별 실전 가이드입니다.

---

## 1단계: 가입 및 개인 작업 환경 세팅

미드저니는 **디스코드(Discord)**라는 메신저 플랫폼 안에서 챗봇 형태로 작동합니다.

1. **디스코드 가입**: [디스코드 공식 홈페이지](https://discord.com/)에서 가입하고 PC 앱을 다운로드하여 로그인합니다.
2. **미드저니 가입**: [미드저니 홈페이지](https://www.midjourney.com/)에 접속하여 **[Sign In]** 또는 **[Join the Beta]**를 누르고 디스코드 계정을 연동합니다.
3. **요금제 구독**: 첫 이용 시 구독이 필요합니다. 홈페이지 마이페이지에서 **[Manage Sub]**을 누르고 요금제를 결제합니다.
   * *추천*: 처음에는 **Basic Plan ($10/월)**으로 시작해 보고, 생성량이 많아지면 **Standard Plan ($30/월)**으로 업그레이드하세요.
4. **개인 디스코드 서버 생성 (필수)**: 
   * 공개 서버(Newbies 채널)에서 이미지를 생성하면 다른 사람들이 만드는 이미지에 내 작업물이 금방 묻혀 찾기 힘듭니다.
   * 디스코드 왼쪽 메뉴의 **[+] 버튼 (서버 추가하기)** ➡️ **[직접 만들기]** ➡️ **[나와 친구들을 위한 서버]**를 선택해 나만의 비밀 방을 만듭니다.
5. **미드저니 봇 초대**: 
   * 미드저니 공식 디스코드 서버에 입장한 후, 우측 멤버 목록에서 **[Midjourney Bot]**을 클릭합니다.
   * **[서버에 추가]** 버튼을 누르고 방금 만든 내 개인 서버를 선택해 연결해 줍니다.

---

## 2단계: '마스터 캐릭터' (기준 얼굴) 생성하기

캐릭터 일관성의 첫 단계는 기준이 되는 얼굴인 **'마스터 이미지'**를 완벽하게 만드는 것입니다. 교육용 립싱크 영상에 쓰기 적합하게 생성해야 합니다.

### 💡 립싱크 최적화 캐릭터 프롬프트 작성 팁
* **정면 샷 (Front-facing)**: 카메라를 정면으로 똑바로 바라보고 있어야 입모양 매칭이 자연스럽습니다.
* **입 닫기 (Closed mouth)**: 벌리고 있으면 오디오 싱크 연산 시 왜곡이 일어납니다.
* **심플한 배경 (Solid background)**: 인물만 따서 편집하기 편하도록 흰색 또는 단색 배경을 씁니다.

### 📝 실전 마스터 프롬프트 예시 (귀여운 애니메이션 풍 선생님)
내 개인 서버 대화창에 `/imagine`을 치고 Enter를 누른 후 아래 프롬프트를 붙여넣습니다.

```text
A beautiful young Korean female teacher character, friendly smile, closed mouth, front-facing, clean solid white background, 2D anime flat illustration style, neat line art, high resolution --ar 3:4 --v 6.0
```
> **[파라미터 해석]**
> * `--ar 3:4`: 세로형 포트레이트 비율 설정
> * `--v 6.0`: 최신 고화질 v6 버전 엔진 활성화

### 🔍 업스케일 및 이미지 링크 복사
1. 프롬프트를 전송하면 4장의 후보 이미지가 나옵니다.
2. 마음에 드는 캐릭터(예: U1 ~ U4 중 1번 선택 시 **U1** 클릭)를 선택해 크게 키웁니다(Upscale).
3. 확대된 이미지를 마우스 우클릭하고 **[링크 복사 (Copy Link)]**를 누릅니다. 이 URL 주소가 캐릭터 얼굴의 고유 코드가 됩니다. (예: `https://media.discordapp.net/attachments/xxxx/yyyy.png`)

---

## 3단계: `--cref` 파라미터로 캐릭터 일관성 유지하기

미드저니의 핵심 기능인 **Character Reference (`--cref`)**를 사용해 다른 행동과 표정을 만들어 냅니다.

### ⚙️ 명령어 기본 구조
`/imagine [새로운 행동/상황 프롬프트] --cref [2단계에서 복사한 마스터 이미지 URL] --cw [0 또는 100]`

### 💡 `--cw` (Character Weight, 캐릭터 가중치) 활용법
* **`--cw 100` (기본값)**: 머리 스타일, 얼굴 모양, 그리고 **입고 있는 옷 스타일**까지 동일하게 복제합니다. (매 쇼츠마다 옷을 고정할 때 추천)
* **`--cw 0`**: 옷을 제외하고 **오직 얼굴 이목구비**만 복제합니다. (캐릭터가 옷을 갈아입는 연출을 하고 싶을 때 필수)

### 💬 실전 활용 프롬프트 템플릿

#### 1. 화난 표정 짓기 (옷은 그대로 유지)
```text
A young Korean female teacher character, angry expression, closed mouth, clean solid white background, 2D anime flat illustration style, neat line art --cref [마스터이미지URL] --cw 100 --ar 3:4 --v 6.0
```

#### 2. 교실 칠판 앞에서 가리키는 동작 (옷 갈아입히기 - 수트 착용)
```text
A young Korean female teacher character wearing a professional grey suit, pointing at a whiteboard, friendly expression, closed mouth, classroom background, 2D anime flat illustration style, neat line art --cref [마스터이미지URL] --cw 0 --ar 3:4 --v 6.0
```

---

## 4단계: 쇼츠 제작을 위한 소스 최종 추출

1. 쇼츠 영상 1편에 필요한 캐릭터 컷(예: 기본 설명 표정, 놀라는 표정, 질문하는 자세 등)을 3~4개 확보합니다.
2. 최종 선택한 이미지들을 고화질로 저장합니다.
3. 배경이 흰색 단색이므로, 나중에 캡컷(CapCut) 등에서 **'크로마키'** 스포이트 기능을 이용해 배경을 없애고 세련된 교실 배경 이미지 위에 합성합니다.
