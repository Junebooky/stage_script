# Cueflow architecture

## 불변 조건과 모드

관객 내용은 canonical script 또는 지정된 로컬 IMAGE뿐입니다. ASR은 시점을 판정하는 evidence이며 Observation/Profile은 대본을 변경하지 않습니다. 명시적 로컬 공연 입력에는 LLM/cloud/CDN이 없습니다. 최신 사용자 요청에 따라 Operator 기본 입력은 기존 브라우저 ASR의 ONLINE PREVIEW이며 오프라인이라고 표시하지 않습니다. 리허설에는 opt-in Soniox 비동기 ASR을 추가했습니다.

| 경계 | DEMO | PERFORMANCE_LOCAL |
| --- | --- | --- |
| 입력 | 브라우저 interim ASR, 선택적 transport | loopback 로컬 ASR, 명시적 수동 운용 |
| 다음 큐 | 2음절 정확 prefix, cooldown 없음 | 구별 가능한 prefix/internal/fuzzy evidence |
| 탐색 | 다음 3개, 실패 시 자동 확대 | 정상 next 1개, 운영자 RESYNC로만 확대 |
| 송출 | 단일 페이지 stage preview | ShowRuntime → Operator → 읽기 전용 Audience |
| 우선순위 | 시연 반응성 | 수동 제어, 오송출 방지, 복구, 속도 |

## Canonical 구조

`data/productions/registry.json`의 `defaultNumberId`가 실제 워크스페이스와 CLI 기본값을 결정합니다. 현재는 M05-2 하나, 36 cues이며 canonical 파일의 Show ID/넘버 수/넘버 ID와 경로를 검증합니다. 없는 대본은 `CANONICAL SCRIPT REQUIRED`입니다. Next.js 서버에서만 파일시스템 loader를 호출하고 클라이언트에는 직렬화한 catalog를 전달합니다. 기존 사용자 import는 보존하며 bundled demo와 완전히 같은 오래된 저장값만 실제 기본값으로 교체합니다. 넘버/대본 교체는 React key로 관측값·프로필·runtime을 격리합니다.

```text
Show → Act[] → MusicalNumber[] → Cue[]
                              CAPTION | OVERLAP | CHORUS | IMAGE
```

기존 `PerformanceScript.segments`와 SOLO는 호환됩니다. `parseShow()`가 legacy를 계층으로 마이그레이션하고 `flattenShow(show, actId)`는 활성 막만 엔진에 전달합니다. demo 16개 canonical 자막은 변경하지 않았습니다. cue ID는 공연 전체에서 고유하며 order는 각 넘버 안에서 증가합니다.

```json
{
  "id": "my-show", "title": "공연 제목", "locale": "ko-KR",
  "acts": [{
    "id": "act-1", "title": "1막",
    "numbers": [{
      "id": "m01", "title": "오프닝",
      "cues": [
        { "id": "c001", "order": 1, "type": "CAPTION",
          "captions": [{ "actor": "배우 A", "text": "확정된 공연 자막" }],
          "matchText": ["확정된 공연 자막"] },
        { "id": "c002", "order": 2, "type": "IMAGE", "captions": [], "matchText": [],
          "image": { "src": "/show/night.png", "alt": "밤 무대" } }
      ]
    }]
  }]
}
```

OVERLAP은 최소 2개 확정 줄을 동시에 출력하는 하나의 큐, CHORUS는 하나의 확정 출력 줄입니다. 화자 분리/병렬 포인터는 없습니다. Audience와 같은 import 한계(큐 ID 256자, 최대 8줄·각 4000자, image alt 2000자)를 검증합니다. Show ID는 최대 200자입니다. 이미지 검사기는 `script-schema/assets`에 있어 Audience가 demo script나 엔진을 import하지 않습니다.

## Runtime과 증거

```text
Mic → AudioWorklet → 16 kHz / 20 ms PCM → loopback WS → Local ASR
       └─ VAD / waveform                                ↓ interim
canonical + profile → matcher → HypothesisCursor → ScriptFollowingEngine
                                                        ↓
                                                    ShowRuntime
                                                        ↓
Operator preview ─────────────────────→ canonical snapshot → Audience
```

Web Audio는 zero gain으로 피드백을 막습니다. 입력 종료 시 track/context/socket/worklet을 해제하고 이전 세대 콜백을 무시합니다. 로컬 입력은 browser recognition 객체를 만들지 않습니다. ONLINE PREVIEW는 Web Audio/VAD/파형을 유지하되 로컬 WS를 열지 않고 기존 BrowserSpeechASRAdapter를 재사용합니다. 엔진 정책은 PERFORMANCE_LOCAL의 next-only 보수적 기준을 유지합니다. 실제 브라우저 서비스 모델명/버전은 앱에서 제어하지 않습니다.

Matcher는 NFC/공백/문장부호 정규화 후 prefix, internal anchor, 로컬 편집 유사도, sequence prior, ASR confidence, speech, 상대 timing을 개별 score로 반환합니다. 공연용 anchor는 기본 4자 이상이며 근처 동일/유사 가사의 실제 증거 품질을 비교하여 구별되지 않는 앞부분으로 다음 큐를 넘기지 않습니다. 짧은 문장은 완전 일치/충돌 검사를 사용합니다. 시작 가사를 놓쳐도 고유한 내부 증거로 원래 전체 caption을 송출합니다. 점수는 보정된 확률이 아닙니다.

HypothesisCursor는 실제 사용한 증거만 소비합니다. 전체 문장 완성/isFinal/침묵을 기다리지 않습니다. 누적 transcript와 수정된 interim에 cursor를 재배치하고 중복을 제거합니다. 검색은 최근 512자 범위로 제한합니다.

### UNMATCHED / fallback

충분한 발화가 있지만 canonical evidence가 약하면 UNMATCHED_SPEECH를 표시하고 기존 출력을 유지합니다. 애드리브로 단정하거나 ASR 원문을 관객에게 보내지 않습니다.

Fallback은 next 큐만 대상으로 명시 enabled, 최소 3회 표본, profile confidence ≥ .85, 직전 정상/수동 cue confidence ≥ .85, 새로운 VAD onset, 직전 cue 기준 상대 timing window, 최소 3자 신규 ASR와 confidence ≥ .35, 합성 confidence ≥ max(.86, profile threshold)를 모두 요구합니다. onset만 유효하면 FALLBACK_READY를 표시하되 **송출하지 않습니다**. ASR이 들어와야 판단합니다. 기본 OFF이며 unknown pointer/HOLD/RESYNC/IMAGE/silence/연속 fallback 체인은 차단합니다. 결과는 FALLBACK으로 구분합니다. 인간 검증과 큐별 허용이 필수입니다.

### 수동 우선권

NEXT/PREVIOUS/JUMP는 즉시 pointer를 바꾸고 현재 증거를 checkpoint로 폐기합니다. 공연 UI의 manual/GO/HOLD/RESYNC는 reset(generation)을 동시에 보내되 수동 처리는 기다리지 않습니다. 백엔드는 PCM/결과를 비우고 이전 추론을 취소·무효화한 뒤 같은 generation의 ACK를 보냅니다. 브라우저는 ACK 전 결과와 이전 세대 결과를 거부하고 ACK 대기 중 PCM 전송을 중단합니다. 3초 timeout은 자동 인식을 unavailable로 표시합니다. 이 경우 마이크 재시작이 필요할 수 있지만 수동 송출은 가능합니다.

엔진 단독 사용도 stale cumulative text를 폐기하며 빈 checkpoint는 새 VAD/utterance 또는 adapter가 검증한 generation을 요구합니다. receipt 시간만으로 새 발화라고 가정하지 않습니다. 공연 HOLD 중 evidence는 버립니다. Demo의 기존 paused-input 행동은 유지합니다.

ONLINE PREVIEW의 수동 조작도 같은 엔진 checkpoint를 설정합니다. 동시에 이전 recognition 참조를 먼저 무효화하고 abort한 뒤 새 인식기를 생성하며 stream/utterance ID에 새 epoch를 붙입니다. 늦은 final/abort 콜백은 이전 포인터를 재사용할 수 없습니다. 모드 교체는 PRE_SHOW와 마이크 OFF일 때만 가능합니다. 로컬 실패에서 온라인으로 자동 전환하지 않습니다.

## 막 제어

```text
PRE_SHOW → ACT_ARMED → GO → ACT_LIVE → 운영자 완료 → ACT_COMPLETE
              ↑                                      ↓
              └── ARM NEXT ACT ← INTERMISSION ←───────┘
마지막 막 완료 → SHOW_COMPLETE
```

GO는 microphone/ASR/assets/output readiness를 요구합니다. 명시적 manualOnly는 microphone/ASR만 면제하고 그 상태를 숨기지 않습니다. GO 이전과 인터미션은 자동/일반 NEXT를 차단합니다. 다음 막 ARM은 pointer/상대 기준/이전 evidence를 격리합니다. 마지막 cue 이후 막을 자동으로 넘기지 않습니다. 인터미션 출력은 시작 전 black/clear/last-caption을 선택합니다. clear는 검은 화면에서 자막이 없는 형태입니다.

## Operator → Audience

Web Locks로 한 운영 창만 권한을 얻고 BroadcastChannel로 local snapshot을 보냅니다. session/단조 epoch/sequence로 오래된 운영 세대와 순서 역전 메시지를 버립니다. epoch는 lock 안에서 localStorage에 보존합니다. StrictMode/대본 교체 재마운트 시 기존 lock 해제를 기다립니다. 저장 대본 hydration 후에만 runtime을 생성합니다.

Payload는 black, caption(cueId/lines), image(cueId/src/alt)만 허용합니다. ASR/배우명/상태/버튼/로그/전체 script를 보내지 않습니다. Audience에는 매칭 로직이 없습니다. hello는 현재 상태 재전송, ACK는 정확한 최신 session/epoch/sequence에만 유효합니다. 500 ms heartbeat와 2500 ms timeout을 사용합니다. ACK는 렌더 준비이지 물리적 표시 측정이 아닙니다.

관객 연결이 끊기면 마지막 화면을 유지합니다. 운영 창은 미준비 동안 마지막 신규 hypothesis 하나를 보류하고 복구 후 평가합니다. 수동 조작은 보류 evidence를 폐기합니다. 이미지는 same-origin/redirect:error로 fetch 후 blob을 decode해 표시합니다. 실패는 BLACK, 이전 image load는 새 cue ACK로 사용되지 않습니다. 동일 origin/profile의 HDMI 확장 화면용이며 LAN 다중 장치나 operator crash/reload 자동 복원은 없습니다.

## 리허설 분석과 저장

FastAPI 원본 upload → 선택한 ASR의 timestamp/word 결과 → `analyzeNumberRehearsal`입니다. 넘버를 아는 현재 경로는 global alignment를 호출하지 않습니다. 넘버 내부 Smith–Waterman 후보를 만든 뒤 겹치는 관측 구간별 반복 후보를 보존하고 beam sequence path로 순서·skip·restart를 평가합니다. 반복 첫 4줄만으로는 A/C를 확정하지 않습니다. 뒤의 고유 대사와 경로 차이가 충분하면 해당 occurrence로 정렬하고, 충돌이 남으면 review-required입니다. 전체 공연 global utility는 별도로 보존했습니다. LIVE 탐색과는 분리된 offline 정책입니다.

Word timestamp가 있으면 관측 범위를 사용하고 없으면 ASR segment 내부 문자 비율로 보간합니다. 둘 다 pseudo-ground-truth입니다. 보간 시 `timingReliable=false`이며 latency/early/late와 상대 타이밍 학습에서 제외합니다. Observation에는 cue/act/number, start/end, ASR, confidence, anchors, previous cue, 상대 timing, gap, collision, reviewStatus, groundTruth, transcriptId, normalizedMatchRange, 반복 후보·해결 근거가 있습니다. 인접 canonical cue이면서 같은 act일 때만 상대 timing을 학습하여 인터미션을 제외합니다.

낮은 정렬 신뢰도/반복 충돌/미정렬은 review queue에 남습니다. 사람은 원본을 듣고 시각을 확인하거나 사유를 남겨 제외합니다. 제외 항목은 정답이 되지 않습니다. 변경은 revision을 올리고 이전 JSON을 보존합니다. raw audio는 generated ID 디렉터리에 저장하고 입력 filename은 경로로 사용하지 않습니다. profile의 Show ID는 디렉터리명으로 SHA-256 해시합니다. 재시작으로 중단된 작업은 failed로 남고 원본을 보존합니다.

AudioSource/LiveMicSource/FileReplaySource는 timestamped PCM 인터페이스와 배속 파일 재생을 구현·테스트했습니다. 실제 upload 전사는 provider 파일 API를, LIVE WS는 adapter 직접 호출을 사용합니다. 전체를 한 실행기로 통합한 상태는 아닙니다. GUI 배속 audio→ASR replay는 없고 회귀 평가는 timestamped ASR replay입니다.

CLI는 설치된 Vite TS module runner를 서버 없이 사용해 실제 앱의 schema/alignment/replay를 실행합니다. Python은 먼저 WAV의 전체 PCM 프레임·메타데이터·SHA-256을 검사합니다. 원본을 변환·덮어쓰지 않고 새 UUID 디렉터리에만 결과를 남깁니다. 모델·키·동의 없음은 exit 2, observation 미생성입니다. CLI 분석과 UI 업로드 이력은 별도 보관됩니다.

### 외부 ASR 경계

Soniox `stt-async-v5`는 서버 `SONIOX_API_KEY`와 명시적 업로드 동의가 모두 필요합니다. 고정 미국 endpoint/redirect 금지/키 비노출, generic 파일명으로 raw upload → job → bounded poll → tokens를 받습니다. canonical 문구·번역·정답 prompt를 보내지 않습니다. 한국어 subword를 공백 단위로 먼저 합치고 음향 pause/문장 끝으로 span을 만듭니다. 단어 시각이 겹치면 시각을 조작하지 않고 span-only로 내려 검토 대상으로 둡니다. `cloud-asr-pseudo`와 `local-asr-pseudo`를 구분합니다.

완료/실패/timeout에서 이 실행이 만든 job/file만 삭제 요청하고 성공 여부를 로컬 감사 파일과 manifest에 기록합니다. 프로세스 강제 종료·업로드 응답 유실에는 원격 자료가 남을 수 있으므로 zero-retention이라고 주장하지 않습니다. 키 누락 시 업로드 전에 실패합니다. Soniox 비동기 분석을 실시간 마이크 스트리밍에 연결했다고 주장하지 않습니다. [API](https://soniox.com/docs/api-reference) · [보관 정책](https://soniox.com/docs/security-and-privacy).

## Cue Profile / Champion–Challenger

Canonical 고유 앵커의 관측 reliability, 이전 cue 대비 onset 중앙값/허용 구간/분산, text/fallback threshold, 독립 녹음 sampleCount, confidence, fallback enabled를 생성합니다. 한 녹음의 반복을 여러 리허설로 세지 않습니다.

이번 경로는 show+number scope로 이력/후보/Champion을 격리합니다. 앵커에는 먼 반복 cue까지 `repetitionRisk`/`competingCueIds`를 저장하고 상대 시각에는 독립 표본 수와 `distributionReady`를 둡니다. 한 녹음은 status=candidate, sampleCount=1, fallback OFF입니다. 반복 앵커만 있는 후보는 fallback 활성화를 허용하지 않습니다.

후보와 Champion은 모든 과거 완료 녹음에 같은 보수적 엔진으로 replay합니다. Cue accuracy, miss/wrong/early/late, P50/P95, recovery, manual/fallback, image entry/exit, human/pseudo/excluded를 측정합니다. 비교 불가 지표도 자동 승인하지 않습니다. 최소 3회, 미해결 검토 없음, 모든 지표 무회귀, 하나 이상 개선이 필요합니다. 서버는 전체 이력/분석 SHA-256/revision/이전 Champion을 다시 검사합니다. 운영자 이름과 승인 후에만 승격하고 이전 Champion을 보존합니다. LIVE 자동 적용은 없습니다.

Canonical fingerprint는 FNV 변경 감지자이며 보안 서명이 아닙니다. 회귀 지표는 브라우저에서 계산하고 서버는 제출 결과의 제약/일관성을 검사합니다. 신뢰 실행 서버나 지속 학습 모델은 아닙니다. 같은 이력으로 calibration/regression하므로 별도 hold-out과 인간 정답으로 과적합·자기평가 편향을 검증해야 합니다.

## 로컬 ASR / 3D / telemetry

선택적 faster-whisper는 실제 로컬 모델만 로드하고 한국어 전사를 수행합니다. rolling-chunk 추론 1개/12초 PCM으로 무한 대기를 제한합니다. RESET은 이전 결과를 generation으로 폐기하지만 이미 시작한 native CPU 연산을 물리적으로 즉시 중단하지는 못합니다. 실제 지연은 장비/모델에 달려 있습니다. 오류는 unavailable로 표시하며 cloud/mock fallback은 없습니다.

Membrane는 ref_new.tsx의 shader 문자열, camera, overscan grid, point size, palette, trajectory를 이식했습니다. stage 컨테이너에 맞추고 음성은 미세한 높이 변화만 더합니다. reduced-motion은 레퍼런스처럼 느리게 움직이고 hidden tab은 멈춥니다. WebGL context 복구/자원 해제/CSS 점 fallback을 지원합니다.

엔진 로그는 raw/normalized ASR, score components, anchor/range, timing, cursor, trigger source, manual/resync, show transition을 포함합니다. 최근 2000건을 메모리에 보관해 운영자가 JSON으로 내보냅니다. 개인정보를 포함할 수 있으며 자동 영구 기록은 아닙니다. 장시간 전체 공연 로그와 물리적 projector latency는 후속 작업입니다.

## 주요 파일

| 경계 | 파일 |
| --- | --- |
| Schema / migration / asset | packages/script-schema/src/index.ts, assets.ts |
| Matcher | packages/alignment/src/index.ts |
| Cue evidence / lifecycle | packages/script-engine/src/index.ts, hypothesis-cursor.ts, show-runtime.ts |
| Rehearsal | packages/rehearsal/src/{alignment,calibration,replay,types}.ts |
| Operator | apps/web/components/OperatorExperience.tsx, hooks/use-performance-session.ts |
| Audience | components/AudienceOutput.tsx, hooks/use-audience-publisher.ts, lib/audience-protocol.ts |
| Mic / protocol | hooks/use-microphone.ts, lib/audio-protocol.ts |
| Visual | components/HologramAvatar.tsx, lib/membrane-shaders.ts |
| Rehearsal UI | components/RehearsalWorkspace.tsx |
| Backend | services/audio-engine/app/{main,rehearsal,sources}.py, adapters/local.py |

이번 변경·실제 파일 검사·남은 항목은 [M05-2 보고서](m05-2-report.md), 이전 단계는 [구현 보고서](implementation-report.md), 측정 정의는 [latency](latency.md)를 참고하세요.
