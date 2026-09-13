# Cueflow — Script-following performance subtitles

배우의 음성으로 **확정 대본의 송출 시점**을 판단합니다. 관객 자막은 항상 canonical script이며 인식 문장으로 대본을 다시 쓰지 않습니다. 실시간 경로에는 LLM이 없습니다.

## 실행

Node.js 22+ / npm, 백엔드는 Python 3.11+가 필요합니다.

```bash
npm install
npm run dev
```

| 화면 | 주소 | 목적 |
| --- | --- | --- |
| Demo | http://localhost:3000/demo | 브라우저 음성 인식, 빠른 2음절 트리거, 제품 시연 |
| Operator | http://localhost:3000/operator | M05-2 운영·온라인 시연, 막 제어, 마이크·자막·큐 분리 |
| Audience | http://localhost:3000/output | 확정 자막 / 로컬 이미지 / 검은 화면만 송출 |
| Rehearsal | http://localhost:3000/rehearsal | 원본 오디오 분석, 검토, 프로필 회귀 평가·승격 |

`ref_new.tsx`의 점 형태 membrane 셰이더·카메라·움직임을 Three.js로 이식했습니다. CDN 없이 로컬 번들로 실행되며 자막과 오디오 파형은 별도로 유지됩니다.

`/`는 `/operator`로 연결됩니다. 실제 기본 대본은 **데카당스 경성 / M05-2 / 36 cues**입니다. 기존 사용자 import는 보존하며 합성 16개 큐는 `/demo`에만 둡니다. [이번 구현·검증 보고서](docs/m05-2-report.md)를 참고하세요.

## 입력과 운영 모드

**DEMO**는 기존 16개 큐 시연입니다. 다음 대사의 처음 두 정규화 음절만 맞아도 전체 확정 자막을 표시합니다. 문장 확정, 쉼, 다음 ASR 업데이트를 기다리지 않습니다. 이 정책은 정확도보다 반응 속도를 우선합니다. 브라우저 음성 인식은 인터넷/브라우저 서비스에 의존할 수 있어 오프라인 공연용이 아닙니다. 움직이는 파형은 입력 성공이지 인식 성공을 뜻하지 않습니다.

**ONLINE PREVIEW**는 Operator의 기본 입력입니다. 기존 브라우저 한국어 interim ASR을 재사용하므로 로컬 모델/API 키 설치 없이 Chrome에서 시연할 수 있습니다. 마이크를 켜면 브라우저 음성 서비스로 음성이 전송될 수 있습니다. 정확한 모델·보관 정책은 브라우저 공급자가 관리하며 이 앱이 특정 모델 버전을 보장하지 않습니다. 무대에는 인식 원문이 아니라 M05-2 확정 자막이 나갑니다. 문장 최종 완성을 기다리지 않으며 아래의 보수적 공연 매칭 정책을 유지합니다. 실제 가창 정확도·음향 지연은 미검증입니다.

**PERFORMANCE_LOCAL**은 별도의 보수적인 엔진 설정입니다. 구별 가능한 prefix/internal anchor, 순서, 발화, 신뢰도와 승인된 리허설 프로필을 사용합니다. 정상 운용은 다음 큐만 검색하고 넓은 재탐색은 운영자가 RESYNC로 요청합니다. 입력 선택에서 `로컬 모델 · 오프라인 공연`을 명시적으로 고르면 브라우저 ASR을 생성하지 않습니다. 로컬 ASR이 준비되지 않으면 `LOCAL ASR UNAVAILABLE`을 표시하며 mock/브라우저/클라우드로 자동 전환하지 않습니다. 수동 운용도 지원합니다. 입력 모드 전환은 PRE_SHOW에서 마이크를 끈 상태에만 가능합니다.

## 로컬 오디오 엔진

```bash
python3 -m venv services/audio-engine/.venv
services/audio-engine/.venv/bin/pip install -e 'services/audio-engine[test]'
npm run dev:backend
```

기본 `/ws/audio`는 **텍스트를 생성하지 않는 transport mock**입니다. `/health`는 기본 transport 생존 확인용입니다. 실제 공연 ASR 상태는 `/readiness`와 `/ws/audio?mode=performance` handshake로 확인합니다.

선택적 실제 로컬 ASR을 사용하려면 공연 전에 다음을 설치합니다. 모델은 저장소에 포함되지 않으며 실행 중 자동 다운로드하지 않습니다.

```bash
services/audio-engine/.venv/bin/pip install -e 'services/audio-engine[local-asr,test]'
# 이미 준비한 한국어 지원 faster-whisper/CTranslate2 모델의 절대 경로로 바꾸세요.
export STAGE_LOCAL_MODEL_DIR=/absolute/path/to/local-korean-model
npm run dev:backend
```

모델 디렉터리에 `model.bin`, `config.json`, `tokenizer.json`, `preprocessor_config.json`이 필요합니다. 기본 CPU/int8이며 `STAGE_ASR_DEVICE`, `STAGE_ASR_COMPUTE_TYPE`으로 변경할 수 있습니다. 모델 로딩은 `local_files_only=True`입니다. 현재는 첫 400 ms 이후 최소 320 ms 간격으로 최대 12초 버퍼를 추론하는 **rolling-chunk faster-whisper**입니다. 음소 스트리밍 CTC/transducer가 아니며 실제 가창 정확도와 저지연 SLA는 검증하지 않았습니다. 리허설 분석과 실시간 마이크의 모델 점유는 상호 배제합니다.

공연 WebSocket은 loopback만 허용합니다. 기본 `ws://localhost:8000/ws/audio?mode=performance`이며 `NEXT_PUBLIC_AUDIO_WS_URL`을 설정해도 외부 서버는 거부합니다. REST는 `http://localhost:8000`을 사용합니다. 허용 브라우저 origin은 `http://localhost:3000`, `http://127.0.0.1:3000`입니다. 운영·관객 창은 **동일 origin·동일 브라우저 프로필**에서 여세요.

## 송출 순서

1. `/operator`에서 기본 M05-2를 사용하거나 `실제 공연 데이터`에서 등록 대본을 선택합니다. 사용자 canonical JSON import와 기존 flat script도 지원합니다.
2. `관객 화면 열기`로 연 `/output`을 HDMI **확장 디스플레이**로 옮깁니다. F 또는 더블클릭으로 전체 화면을 켭니다. OS 디스플레이 설정은 직접 해야 합니다.
3. 입력 선택 확인 → `ARM` → 마이크/선택한 ASR/이미지/관객 화면 준비 확인 → `GO`. GO 이전에는 음성이나 NEXT로 송출되지 않습니다.
4. 발화에 따라 자동 송출합니다. PREVIOUS/NEXT/HOLD/RESYNC는 즉시 반영합니다. 로컬 입력은 reset ACK 이후 새 세대만, 온라인 시연은 교체한 인식기의 새 세대만 자동 판정합니다. 이전 인식기의 늦은 final은 무시합니다.
5. 마지막 큐에서 `이 막 완료` → `ENTER INTERMISSION` → 다음 막 `ARM` → 준비 확인 → `GO`. 인터미션 중 NEXT와 음성이 다음 막을 시작하지 않습니다.

`Space/→`: NEXT, `←`: PREVIOUS, `H`: HOLD/RESUME, `R`: RESYNC. 입력 필드/버튼 포커스 중에는 전역 단축키가 개입하지 않습니다. IMAGE는 **운영자가 직접 진입**하며 이후 다음 텍스트 큐는 새 발화로 자동 전환할 수 있습니다. 침묵만으로 이미지를 만들거나 건너뛰지 않습니다.

관객 창은 읽기 전용 복제본입니다. 중복 운영 창은 송출권을 얻지 못합니다. 관객 연결이 끊기면 마지막 수신 화면을 유지하고 운영 창은 자동 매칭을 대기합니다. 새 관객 창은 현재 상태를 수신합니다. 운영 창 자체의 새로고침은 **포인터를 복원하지 않고 PRE_SHOW**에서 시작하므로 공연 중 새로고침하지 마세요.

이미지는 `apps/web/public/show/scene.png`에 미리 저장하고 `/show/scene.png`로 참조합니다. 영문/숫자/`_`/`-` 디렉터리와 PNG/JPEG/WebP/GIF/AVIF 파일명을 사용하세요. 외부 URL, 인코딩 경로, 공백, SVG, 쿼리, redirect는 허용하지 않습니다. 에셋 실패는 검은 화면으로 처리합니다.

## 리허설 보정

```text
Audio → 선택한 ASR → Known-number Local Cue Alignment
      → Observation / Review → Cue Profile → 전체 이력 Replay → 운영자 Promotion
```

`/rehearsal` 기본값은 M05-2와 **Soniox stt-async-v5**입니다. 선택한 넘버의 WAV/FLAC/M4A/MP3를 업로드하면 백엔드가 timestamp ASR을 만들고 브라우저가 그 넘버 내부만 정렬합니다. 다른 넘버를 녹음했다면 해당 canonical을 먼저 등록·선택하세요. Global alignment는 별도 유틸리티이며 이 경로에서는 사용하지 않습니다. 자동 시각은 **pseudo-ground-truth**이며 직접 듣고 시각/검토자 이름을 저장한 경우만 `HUMAN CONFIRMED`입니다. 단어 시각 없는 보간 결과는 정밀 latency 평가에서 제외합니다. 미정렬·반복 충돌은 검토 목록에 남습니다.

Soniox는 한국어, 토큰 시각·신뢰도를 제공하는 현재 외부 모델로 선택했습니다. 한국어 뮤지컬에 대한 독립 비교 없이 절대적인 최고 성능을 주장하지 않습니다. [모델](https://soniox.com/docs/stt/models) · [시각](https://soniox.com/docs/stt/concepts/timestamps) · [신뢰도](https://soniox.com/docs/stt/concepts/confidence-scores).

백엔드를 실행하는 셸에 `SONIOX_API_KEY`를 설정한 뒤 서버를 재시작하세요. 키를 채팅·브라우저·Git에 넣지 마세요. `.env` 파일을 자동 로드하지 않으며 서버 환경변수를 사용합니다. 화면의 외부 전송 동의 또는 CLI의 `--allow-cloud-upload`가 없으면 네트워크 요청 전에 중단합니다. 파일 전체를 Soniox 미국 API로 보내며 canonical 대본은 전송하지 않습니다. 결과 수신 후 이 실행의 원격 전사·파일만 삭제 요청합니다. 삭제 실패는 `external-asr.json`과 이력 경고에 기록합니다. 삭제되지 않은 비동기 자료는 서비스 정책에 따라 최대 30일 보관될 수 있습니다. [보관 정책](https://soniox.com/docs/security-and-privacy).

### M05-2 원본 검사·분석 명령

등록 원본의 실제 경로는 `recordings/decadence-gyeongseong/R001/M05-2/M5-2_외로운별 _0420.wav`입니다. 요청 문서의 경로와 달리 R001 하위이며 파일명에 공백이 있습니다. 원본을 이동·개명하지 않고 registry에 실제 경로를 등록했습니다.

```bash
# 외부 전송 없음: 24-bit WAV 전체 디코딩 + 전후 SHA-256 검사
npm run rehearsal:analyze -- --number M05-2 --inspect-only

# 키 설정 및 해당 녹음의 Soniox 미국 업로드 승인 후에만 실행
npm run rehearsal:analyze -- --number M05-2 --provider soniox --allow-cloud-upload

# 이미 설치된 로컬 모델을 명시적으로 사용하는 경우
npm run rehearsal:analyze -- --number M05-2 --provider local
```

매번 `.stage-data/number-analysis/run-<UUID>/`를 만들고 원본/이전 실행을 덮어쓰지 않습니다. `inspection.json`, `status.json`, `run.json`; 실제 ASR 성공 시 `observation.json`, `alignment.json`, `metrics.json`, 근거가 있으면 `candidate-profile.json`을 추가합니다. 외부 호출 감사는 `external-asr.json`입니다. 성공 0 / 실패 1 / 모델·키·동의 없음 2로 종료합니다. CLI 결과는 업로드 이력에 자동 합쳐지지 않습니다. 현재 실제 원본은 검사만 완료했으며 외부 전사·실제 후보·음향 성능 수치는 아직 없습니다.

다음 넘버는 `data/productions/registry.json` 항목과 그 항목의 canonical JSON을 추가합니다. 기본값은 registry의 `defaultNumberId` 하나로 관리합니다. canonical 없는 항목은 `CANONICAL SCRIPT REQUIRED`로 비활성화합니다. 실제 M06 등 미제공 대본을 생성하지 않았습니다.

프로필은 고유 앵커, 이전 큐 대비 중앙 타이밍/허용 범위/분산, 매칭 임계값, 독립 리허설 수, 신뢰도를 포함합니다. Fallback은 기본 OFF이며 큐별 선택 + 3회 이상의 안정된 표본이 필요합니다. 후보는 모든 과거 완료 녹음을 같은 공연 엔진으로 replay합니다. 최소 3회, 미해결 검토 없음, 모든 지표 무회귀, 측정 가능한 개선, 운영자 이름과 승인이 있어야 Champion이 됩니다. 분석/이력/기존 Champion 변경은 오래된 승격을 차단합니다. 승인 프로필은 운영 화면에서 별도로 불러오며 LIVE 중 교체는 금지합니다.

저장 위치는 `.stage-data/`이며 `STAGE_DATA_DIR`로 변경합니다. 원본, 분석 revision, 후보, 이전 Champion을 보존합니다. `.stage-data/`, `rehearsal-recordings/`, `local-models/`는 Git 제외 대상입니다. 다른 경로에 저장한 민감한 녹음/로그도 Git에 넣지 마세요. 업로드 기본 상한은 2 GiB(`STAGE_MAX_AUDIO_BYTES`)입니다. 중단 작업은 재시작 시 failed로 남기며 원본을 보존합니다. 재시도 API는 `POST /rehearsals/{id}/retry`이며 UI 재시도 버튼은 아직 없습니다.

## 인터넷 없이 실행

공연 전에 의존성·브라우저·모델·이미지를 준비하고 빌드합니다. 이후 웹 서버와 로컬 백엔드를 실행합니다.

```bash
npm run build
npm run start:local
```

명시적으로 선택한 **로컬 공연 입력**의 critical path에는 외부 API·CDN·웹 폰트가 없습니다. Node/Python 서버, 지원 브라우저(Web Locks/BroadcastChannel/Web Audio), OS 입력·디스플레이 장치는 필요합니다. 설치형 데스크톱 앱이나 서비스 워커 캐시는 아닙니다. Demo·ONLINE PREVIEW·Soniox 분석에는 오프라인 보장이 적용되지 않습니다.

## 검증과 배포 경계

```bash
npm test
npm run typecheck
npm run build
npm run test:backend
npx playwright install chromium
npm run test:e2e
```

실제 모델 통합 테스트는 사전 준비된 `STAGE_TEST_LOCAL_MODEL_DIR`, `STAGE_TEST_KOREAN_AUDIO`를 설정해야 실행됩니다. CI가 모델이나 비공개 녹음을 다운로드하지 않습니다. 브라우저 테스트의 ASR은 합성 데이터이며 실제 한국어 발화·가창 성능을 증명하지 않습니다.

Latency는 `음성→표시`, `인식→표시`, `수동→표시`를 구분하고 Operator는 **미리보기** 측정임을 명시합니다. 인식→표시는 ASR 대기 시간을 포함하지 않으며 HDMI/프로젝터의 물리적 표시 시간도 측정하지 않습니다.

현재는 실공연 승인 전 단계입니다. [구현 보고서](docs/implementation-report.md), [아키텍처](docs/architecture.md), [지연 측정·현장 검증](docs/latency.md)을 확인하세요.
