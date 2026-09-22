# Cueflow — Coding Agent 개발 인수인계

작성·현 상태 확인: **2026-09-22**. 경로는 별도 표시가 없으면 저장소 루트 기준이다.

> 게시 변경 안내: 문서 작성 후 사용자가 현재 버전의 commit/push를 승인했다. 아래의 “미커밋 5개”, “push 미승인”, working tree 상태는 **인수인계 초안 작성 시점의 기록**이다. 이번 게시 커밋에는 해당 소스·테스트 5개와 이 문서를 함께 포함한다. 이후 인수 시 `git log -1 --oneline`과 `git status --short`로 최신 상태를 확인한다. 오디오·모델·환경설정·raw artifact는 여전히 Git에 포함하지 않는다. 이 승인은 향후 임의 push까지 허용하는 것은 아니다.

게시 전 추가 검증: unit 200 PASS, typecheck PASS, backend 80 PASS/1 SKIP, production build PASS. E2E는 이번 게시 작업에서 재실행하지 않았다.

## 1. 먼저 알아야 할 결론

Cueflow는 **배우의 음성으로 이미 확정된 공연 대본의 송출 시점을 결정하는 제품**이다. 일반 STT 자막 생성기가 아니다. 관객에게는 ASR 인식문이 아니라 canonical 대본만 표시한다. 실시간 판단 경로에 LLM은 없다.

- saved-ASR completed-word replay 최적화 milestone은 완료·종료했다. 기준 로컬 커밋은 `60a0e62 perf(replay): add guarded completed-word early cue matching`이다.
- 후속 real streaming 측정용 코드 5개는 구현되어 있지만 **아직 untracked / 미커밋**이다. 버리거나 이미 GitHub에 있다고 가정하지 말 것.
- 로컬 faster-whisper 설치 및 모델 준비를 마쳤다. 실제 M05-2 WAV 전체 226.138초를 1.0x PCM으로 공급한 실측도 완료했다. 이전의 “모델 없음 / faster_whisper 미설치” blocker는 이 머신에서는 해소됐다.
- 그러나 **독립적으로 검토된 cue별 오디오 onset 정답이 없다.** 따라서 onset 기준 live latency, unsafe early-trigger rate, completed-word 대비 실제 개선폭은 아직 확정할 수 없다.
- 다음 우선순위는 모델 교체나 UI 재설계가 아니라 **기존 실측의 평가 체계 완성 → 첫 정체 지점 분석 → 안전성을 보존한 후속 실험**이다.
- 이 문서 작성 요청에서는 구현을 추가 진행하거나 commit/push하지 않았다. 다음 Agent도 별도 요청 없이 push하지 말 것.

## 2. 인수 시 저장소 상태와 전달 범위

현재 작업 경로: `/Users/gotow/Documents/neonfamily101/stage_script`.

```text
60a0e62 perf(replay): add guarded completed-word early cue matching
dba9c96 Add recording-scoped realtime replay with canonical audience output
202f431 Prepare verified Free Tier FLAC uploads for Groq rehearsal ASR
c8c2d9e Add Groq rehearsal ASR with consent, provenance and verification
b57d8c6 feat: add production cue workflow and M05-2 rehearsal analysis
```

문서 작성 직전 `git status --short`는 다음 5개만 untracked였다. 이 문서도 새 파일로 추가된다. **Working tree는 clean이 아니다.** 이번 확인에서 원격 fetch/push는 하지 않았으므로 GitHub 최신 상태와 로컬 HEAD가 같다고 단정하지 않는다.

```text
packages/rehearsal/src/streaming-shadow.test.ts
packages/rehearsal/src/streaming-shadow.ts
scripts/analyze-streaming-measurement.mjs
services/audio-engine/app/streaming_measurement.py
services/audio-engine/tests/test_streaming_measurement.py
```

다른 머신/Agent에 넘길 때 Git clone만으로는 충분하지 않다.

| 구분 | 전달/확인 방법 |
| --- | --- |
| 커밋된 소스 | 로컬 `60a0e62`가 인수한 저장소에 존재하는지 확인 |
| 위 5개 미커밋 소스 + 이 문서 | 별도 작업 파일 전달 또는 사용자 승인 후 선별 커밋 필요 |
| WAV, `.stage-data/` 실측/전사 artifact | Git 제외 자료. 사용자 허용 범위에서 별도 비공개 전달 |
| 로컬 모델, Python `.venv` | Git 제외. 다른 머신에서는 설치·준비 필요 |
| `.env.local`, API 키 | 문서/패치/로그에 포함하지 말고 필요한 로컬 설정만 안전하게 재구성 |

원본 오디오와 raw ASR 결과는 비공개 공연 자료로 취급한다. `.gitignore`에 `recordings/`, `.stage-data/`, `local-models/`, `.venv/`, `.env*`(example 제외), 오디오 확장자, 사용자 `ref*.md/tsx`, 계획 원문, 빌드/테스트 산출물이 제외되어 있다. `git add .` 대신 파일별 allowlist를 사용한다.

## 3. 제품과 코드 구조

Node.js 22+ / Python 3.11+ 기반 npm workspace 모노레포다. 현재 package 기준 Next.js 16.3.4, React/Three.js, TypeScript 7.0.2, Vitest, Playwright, FastAPI를 사용한다.

| 경로 | 역할 / 주의점 |
| --- | --- |
| `apps/web/app/` | `/operator`, `/output`, `/rehearsal`, `/demo`; `/`는 operator로 이동 |
| `apps/web/components/` | 운영·관객·리허설 UI와 membrane 3D 시각화 |
| `apps/web/hooks/use-microphone.ts` | 기존 마이크/audio worklet/WebSocket 경로. 현재 파일 측정에서는 사용하지 않음 |
| `apps/web/hooks/use-browser-performance-asr.ts` | 브라우저 ONLINE PREVIEW 입력 |
| `apps/web/hooks/use-recording-replay.ts` | saved recording replay의 실제 media clock 연동 |
| `apps/web/hooks/use-performance-session.ts` | 운영 세션·엔진 연동 |
| `apps/web/lib/audience-protocol.ts` | 관객 publisher lock, sequence, ACK, 동기화 |
| `packages/script-schema/src/` | Show/Act/Number/Cue, canonical 검증, 에셋 및 구형 flat script 지원 |
| `packages/alignment/src/index.ts` | 기본 `PrefixFuzzyMatcher`, 한국어 정규화 |
| `packages/alignment/src/discriminative-word-matcher.ts` | saved-completed-word 전용 opt-in matcher |
| `packages/script-engine/src/index.ts` | `ScriptFollowingEngine`, 순서/매칭/수동/hold/fallback |
| `packages/script-engine/src/hypothesis-cursor.ts` | 소비한 evidence와 이전 큐 꼬리 재사용 방지 |
| `packages/script-engine/src/show-runtime.ts` | PRE_SHOW/ARM/GO/막/인터미션/readiness |
| `packages/rehearsal/src/` | known-number alignment, review/profile, recording projection/replay/evaluation |
| `packages/shared/src/` | 공통 오디오·프로토콜 타입 |
| `services/audio-engine/app/main.py` | `/health`, `/readiness`, `/ws/audio`, 리허설 API |
| `services/audio-engine/app/adapters/local.py` | 로컬 provider 및 `LocalStreamingASR` |
| `services/audio-engine/app/sources.py` | PCM 디코딩, AudioFrame, 파일/마이크 소스 |
| `services/audio-engine/app/registered_replay.py` | 등록된 원본·저장 ASR 근거의 읽기 전용 검증/로딩 |
| `services/audio-engine/app/rehearsal*.py` | 배치 리허설 분석/CLI/provider 경계 |
| `data/productions/` | 실제 공연 canonical 데이터 및 registry |
| `data/replay-recordings/` | R001 recording 전용 profile/reference/registry |

프론트엔드 수정 전 `apps/web/AGENTS.md`, `apps/web/CLAUDE.md`를 읽는다. 특히 설치된 Next.js의 `node_modules/next/dist/docs/`에서 관련 문서를 확인해야 한다. 과거 버전 지식으로 API를 추정하지 않는다.

### 혼동하면 안 되는 세 가지 경로

```text
배치 리허설: 녹음 → 선택한 batch ASR → known-number alignment → 검토 → candidate profile
저장 ASR replay: 실제 WAV media clock → 저장된 completed word → replay 전용 matcher → 평가
현재 실측: 실제 WAV 1.0x PCM → 실제 LocalStreamingASR → 실제 partial/final 기록 → shadow 평가
```

배치 endpoint가 구현되어 있다는 사실은 현재 실험에서 외부 API 사용을 허용한다는 뜻이 아니다. 저장 ASR replay의 latency도 실제 live ASR latency가 아니다.

## 4. 반드시 유지할 안전 정책

1. 관객 자막은 canonical 원문만 사용한다. ASR로 대본을 생성·교정하지 않는다.
2. `PERFORMANCE_LOCAL` 기본 matcher는 `PrefixFuzzyMatcher`다. 정상 운용에서는 다음 큐 1개만 후보이고, 넓은 재탐색은 운영자 RESYNC 권한이다.
3. `/demo`의 두 음절 고속 정책을 실제 공연 정책에 가져오지 않는다. ONLINE PREVIEW도 오프라인 공연용으로 표현하지 않는다.
4. `DiscriminativeWordMatcher`는 saved-completed-word replay 전용이다. `evidenceBasis: "saved-completed-words"` 계약을 실제 streaming partial에 붙이지 않는다.
5. reference timing, cue ID별 예외, 특정 가사 치환표로 trigger를 맞추지 않는다. reference는 downstream 평가에서만 사용한다.
6. 기존 cursor/이전 큐 꼬리 차단/발화 세대/수동 TAKE/HOLD/ARM·GO 안전 장치를 약화하지 않는다.
7. 이번 replay·streaming 실험은 fallback OFF / profiles 빈 목록이다. 다른 경로에 기존 profile 기반 fallback 기능이 있다고 이번에 켜지 않는다.
8. 실제 streaming 실험은 shadow engine만 사용한다. 관객 화면 송출, microphone, speaker, BlackHole을 사용하지 않는다.
9. 외부 Groq/Soniox ASR 호출·오디오 전송은 금지한다. 로컬 모델 다운로드와 설치만 직전 milestone에서 승인되었다.
10. canonical 36개, 원본 WAV, 기존 실측 capture를 보존한다. 실패 시 mock/browser/cloud로 자동 fallback하지 않는다.
11. 단일 녹음 결과로 production-ready를 선언하거나 Champion profile을 자동 승격하지 않는다. sampleCount=1을 다수 실험처럼 부풀리지 않는다.
12. API 키, Authorization header, `.env.local` 내용은 Git/보고서/브라우저/로그에 기록하지 않는다.

## 5. 실제 데이터와 불변 기준

Canonical: `data/productions/decadence-gyeongseong/numbers/M05-2.json` — **36 cues**.

R001 녹음에 실제 존재하는 대상은 **27 cues: C001–C008, C018–C036**이다. C009–C017의 9개 absent cue는 recording-specific projection에서만 제외한다. canonical에서 삭제하거나 전역 자동 skip으로 구현하면 안 된다. 실제 ID는 `M05-2_C001` 형식이다.

원본 경로(파일명 공백 주의):

```text
recordings/decadence-gyeongseong/R001/M05-2/M5-2_외로운별 _0420.wav
```

- 48 kHz / stereo / 24-bit WAV, 65,213,494 bytes, 226.138479초.
- WAV SHA-256: `2b7ce5887f92a5527f4dca1564d00aa2c95eb834ca2e0d6d06189b4588cdb5e7`.
- Canonical SHA-256: `823e4630702aa3c1be4b2b59fed7fd10507ae3c0a459dcf8bb098407bfe73e74`.
- 원본의 이동/개명/수정/덮어쓰기/trimming/tempo change/silence removal 금지.

기존 실제 Groq 결과는 아래 디렉터리에 있다. 이번 streaming 입력에는 사용하지 않았다.

```text
.stage-data/number-analysis/run-167571f2-8599-40db-9f76-b24dcf08c5c9/
  external-asr.json
  alignment.json
```

정규화된 저장 근거는 129 words / 24 segments이며 word confidence는 unavailable/null이다. Segment logprob 기반 수치는 native word confidence와 구분한다.

`data/replay-recordings/R001-M05-2.reference.json`은 **ASR-assisted silver reference**이지 독립적으로 사람이 확인한 acoustic onset 정답이 아니다. 기존 가사 반복 C001–C004 vs C018–C021, 가창→spoken→가창 전환, chorus/duet 구간은 계속 별도 검증 대상이다.

## 6. 완료된 saved-ASR replay 기준선

상세 근거: [recording-replay-early-evidence-report.md](recording-replay-early-evidence-report.md). 이 milestone을 다시 구현하지 않는다.

| 실제 full-WAV 브라우저 replay | 기본 matcher | completed-word opt-in |
| --- | ---: | ---: |
| 올바른 관객 자막 | 27/27 | 27/27 |
| Wrong / miss / 반복 혼동 / fallback | 0 | 0 |
| Median | 3,146.229 ms | 1,826.523 ms |
| P95 | 3,968.954 ms | 3,472.675 ms |
| 평균 소비 단어 수 | 2.222 | 1.370 |

이 값은 **저장된 완료 단어의 `word.end <= audio.currentTime` 조건을 유지한 replay** 결과다. 실제 ASR partial arrival 또는 음향 인식 지연 개선으로 표현하지 않는다. 1,500 ms late 기준에서는 개선 후에도 browser run에 16개 late cue가 있었다.

핵심 artifact (`.stage-data/replay-evaluations/` 하위):

- Before browser: `browser-74e0d294-f470-4e15-9f3f-36612edb1ff2/evaluation.json`.
- After browser: `browser-74378d4e-f8a4-4d3d-bd74-983e0a67ab04/evaluation.json` 및 `browser-validation.json`.
- Deterministic before/after: `check-beef7ea5-587b-40a4-9360-8cf1139544bd/`, `check-90923a39-a76b-4c02-8857-31376297f17c/`.
- Per-cue progression: `latency-b6cacbb3-d58a-4ace-aa78-157bf1f6ab92/progression.json`.

2026-09-20 freeze 검증은 build PASS, unit 192 PASS, typecheck PASS, backend 78 PASS/1 SKIP, E2E 32 PASS였다. 이는 아래 새 streaming 코드 검증과 구분한다.

## 7. 현재 로컬 ASR 환경

실측 머신: Apple M4 Pro, CPU 12코어(8P+4E), GPU 16코어, 메모리 24 GB, macOS arm64. Python 3.13.5.

백엔드의 기존 `.venv`에 faster-whisper **1.2.1**, CTranslate2 **4.8.2**, PyAV **18.1.0**, NumPy **2.5.3**이 설치되어 있다. `pyproject.toml`의 허용 범위는 `faster-whisper>=1.1,<2`이며 정확한 버전 lock은 아니다.

모델은 multilingual `Systran/faster-whisper-small`, revision `536b0662742c02347bc0e980a01041f333bce120`이다. 속도/한국어 정확도 균형을 위한 시작점이며 모델 간 한국어 뮤지컬 정확도 비교로 최선임을 입증한 것은 아니다. **CPU/int8**을 사용하며 Apple GPU를 활용하지 않는다.

```text
/Users/gotow/Library/Application Support/Cueflow/models/faster-whisper-small
```

필수 구조는 `model.bin`, `config.json`, `tokenizer.json`, `preprocessor_config.json`이다. `vocabulary.txt`도 있다. Systran 모델 저장소에 없던 `preprocessor_config.json`은 `openai/whisper-small`에서 별도 준비했다. 이 추가 파일은 현재 다운로드 revision이 고정되어 있지 않으므로 재현성 강화 시 manifest/hash를 남길 것.

기존 ignored `services/audio-engine/.env.local`에는 다음 비밀이 아닌 설정이 추가되어 있다. 다른 머신에서는 모델 절대 경로를 바꾼다. **같은 파일에 비밀키가 있을 수 있으므로 파일 전체를 출력하거나 덮어쓰지 않는다.**

```dotenv
STAGE_LOCAL_MODEL_DIR="/Users/gotow/Library/Application Support/Cueflow/models/faster-whisper-small"
STAGE_ASR_DEVICE=cpu
STAGE_ASR_COMPUTE_TYPE=int8
HF_HUB_OFFLINE=1
```

실제 run에서 `/readiness`의 `local_ready=true` 및 `/ws/audio?mode=performance`의 `faster-whisper-local` handshake를 확인했다. `/health`와 query 없는 `/ws/audio`는 transport/mock 확인이므로 준비 완료 근거로 대신 쓰지 않는다.

기존 adapter는 첫 400 ms 이후 최소 320 ms 새 오디오 간격, 최대 12초 rolling buffer, 동시 추론 1개로 동작한다. 한국어/temp 0/beam 1, VAD filter OFF, 이전 text conditioning OFF다. 약 600 ms silence에서 final을 만들지만 음악이 지속되면 final이 드물 수 있다. 동일 non-final text는 재전송하지 않는다.

따라서 이것은 **실제 스트림 입력에 rolling-window Whisper 추론을 수행하는 방식**이지 음소 단위 native streaming 모델은 아니다. 무응답은 안정성의 증명이 아니고, window가 이동해 과거 text가 사라지는 것도 곧 인식 오류는 아니다.

## 8. 실제 226초 streaming 실행 결과와 한계

Artifact 디렉터리:

```text
.stage-data/streaming-measurements/run-6d4202c4-697f-429f-96f0-c959f4a7ef8d/
  capture.json
  shadow-analysis.json
  onsets.review-template.json
```

`capture.json`은 complete=true, error=null, sourceUnchanged=true다. 원본 WAV를 메모리에서 16 kHz mono s16le PCM으로 디코딩하여 20 ms 프레임을 **해당 프레임 끝 시각 이후** loopback WS로 공급했다. 원본 226,138.479 ms와 PCM 226,138.500 ms의 차이는 반올림 범위다. 11,307 frames 전체 공급 후 10초 drain했으며 final 유도를 위한 인공 침묵은 추가하지 않았다.

| 측정 항목 | 결과 / 해석 |
| --- | --- |
| 실제 ASR 이벤트 | 114개 = partial 112 + final 2 |
| 추론 호출 | 203회 |
| 추론 wall time 합 | 223,043.601 ms |
| 추론당 median / P95 | 1,033.540 / 1,449.973 ms |
| 반복 분석 window 합 대비 RTF | 0.096986; 중복 window 길이가 분모임 |
| 원본 길이 대비 rolling compute load | **0.986314**; 공급 시간 대부분을 추론에 사용 |
| PCM 공급 wall/source 비율 | 1.000006; 1.0x pacing 확인값이지 모델 속도가 아님 |
| 프레임 송신 lag median / P95 | 1.171 / 2.044 ms |
| Immediate baseline shadow | 23개 trigger, C033–C036 4개 미송출 |
| Stable-gated shadow | 10개 trigger, C020–C036 17개 미송출 |
| 현재 partial rewrite 지표 | 103/110 = 93.64%; 아래 제한 참조 |
| t1/t2/t3/t5 onset-relative median/P95 | **N/A — 독립적인 t0 없음** |
| Unsafe early-trigger rate | **N/A — 독립 판정 기준 없음** |
| Completed-word 대비 실제 latency 개선폭 | **N/A — 유효한 비교 아직 불가** |

RTF 0.097만 보고 “실시간 대비 10배 여유”라고 쓰면 안 된다. 12초 중복 window를 계속 추론하므로 실제 compute load는 거의 1이다. 320 ms 설정도 320 ms마다 실제 partial이 도착한다는 뜻이 아니다.

Silver-reference 보조 audit에서는 immediate correct/wrong/miss=23/0/4, stable=10/0/17, 반복 혼동 및 early=0으로 기록됐다. **독립적으로 확인된 정확도나 unsafe=0 주장이 아니다.** 앞 큐에서 정체되면 이후 큐가 연쇄 miss가 되므로 각 miss를 별개의 ASR 실패로 세지 않는다.

현재 revision 지표는 같은 utterance의 비교 가능한 non-final 업데이트 중 deletion/replacement 비율이다. 단순 추가는 분자에서 제외한다. Rolling window 이동, 문장부호 변화, 재디코딩을 포함하므로 “93.64% 오인식”이 아니다. Trigger anchor의 이후 소실은 두 전략 모두 100%로 잡히지만 정상적인 과거 window 제거까지 포함한 수치다. **False-trigger rate로 사용 금지.**

## 9. 새 코드 5개의 역할과 미완료 부분

- `services/audio-engine/app/streaming_measurement.py`: 기존 app/provider를 임시 loopback 서버에서 실행하고 readiness/실제 performance WS를 확인한다. 원본 hash, 실제 PCM 송신, monotonic 수신 시각, ASR 이벤트, 추론 시간을 저장한다. Python audit hook으로 non-loopback socket 연결을 차단한다. 외부 ASR·대본·saved ASR·audience publisher를 입력하지 않는다.
- `packages/rehearsal/src/streaming-shadow.ts`: 원본 이벤트 순서대로 두 shadow engine을 평가한다. Immediate는 기존 baseline, stable은 baseline을 완화하지 않고 anchor가 서로 다른 text 업데이트 2개 이상에 걸쳐 최소 150 ms 유지될 때만 허용한다. 이 gate는 실험용이지 승인된 공연 정책이 아니다.
- `scripts/analyze-streaming-measurement.mjs`: R001의 canonical 27-cue projection으로 평가하고 silver를 별도 사후 audit에만 사용한다. 분석 JSON과 비어 있는 독립 onset 검토 template을 만든다.
- `packages/rehearsal/src/streaming-shadow.test.ts`: baseline 유지, revision, stability, future cue 방지, 가짜 onset 방지 등 8개 테스트.
- `services/audio-engine/tests/test_streaming_measurement.py`: loopback 제한 등 2개 테스트.

다음 Agent가 우선 검토할 구현상 제한:

1. 독립 onset annotation을 읽고 검증하는 경로가 아직 없다. Template은 모든 sample 값이 null/unreviewed다.
2. 현재 `t1`은 null이고, `t2`는 현재 후보로서 처음 baseline evidence를 얻은 partial 시점이다. 이전 큐 정체와 무관한 각 cue의 잠재적 최초 evidence 시점까지 측정하지 않는다.
3. 현재 `t3`는 stable 전략의 실제 trigger 시각과 같게 기록된다. Evidence stability 자체와 엔진 진입 가능 시점을 분리해야 한다.
4. 현재 `t4`는 해당 ASR utterance의 final이지 cue별 final이 아니다. 장시간 음악 utterance에서는 같은 final이 여러 cue에 해당할 수 있다.
5. Revision diff는 공통 prefix/suffix를 제외한 편집 구간이지 최소 edit alignment가 아니다. `start_ms` 이동에 기반한 window-shift 표시도 근사다.
6. Anchor 소실의 “오인식 취소”와 “정상 window eviction” 구분이 부족하다. 최종 정답 또는 소실 여부로 과거 trigger를 정당화하면 안 된다.
7. Capture 성공 경로는 실측했지만 startup 실패·수신 오류·cancellation 시 provider instrumentation 복원, thread 종료, 부분 artifact 보존을 추가 점검해야 한다.
8. Analyzer는 `flag: "wx"`로 결과를 생성한다. **같은 capture 디렉터리에서 재실행하면 EEXIST**다. 원래 artifact를 지우지 말고 새 분석 output 옵션/버전 디렉터리를 설계한다.

## 10. 다음 바로 진행할 작업 순서

### A. 인수 상태와 근거 고정

`git log -1 --oneline`, `git status --short`를 확인하고 위 5개 파일을 직접 읽는다. 새 clone에 없다면 코드/비공개 artifact 전달을 먼저 요청한다. 원본 SHA와 capture의 SHA를 확인한다. 측정을 다시 하기 전에 기존 capture로 진단 가능한 부분을 끝낸다.

### B. 독립 오디오 onset reference 준비 및 검증 경로 구현

실제 원본 오디오를 검토한 cue별 onset/end 및 필요하면 첫 discriminative word의 acoustic end를 별도 annotation으로 받는다. 사람의 검토 없이 human-confirmed로 표시하지 않는다. Streaming 실험의 speaker/mic 금지 조건은 그대로 유지하고, 독립 청취 검토가 필요하면 담당 검토자에게 자료를 요청하거나 별도 허용을 확인한다.

필수 metadata: 원본 SHA, 원본 sample rate 48,000, cue ID, onsetSample/endSample, reviewer, review 상태, 불확실성/허용 오차, 반복/duet 모호성 메모. Silver/live ASR timestamps를 복사해 gold로 만들지 않는다. Sample 범위·큐 집합·자료 해시·검토 상태를 검증하고 누락은 null로 남긴다.

### C. t0–t5 정의와 분석 완성

Capture의 `originNs`를 공통 시작점으로 한다. Audio reference는 `sample / 48000 * 1000`으로 source clock에 매핑하고 이벤트는 `(receivedNs - originNs) / 1e6`을 사용한다. 송신 lag/시간축 변환 오차를 별도 보고한다. ASR `start_ms/end_ms`에서 t0를 추정하지 않는다.

| 항목 | 정의 / 구현 조건 |
| --- | --- |
| t0 audio onset | 독립 검토된 해당 cue의 최초 발성 sample 시점. 반주 시작과 구분 |
| t1 first partial | 해당 cue의 실제 발성을 반영한 첫 non-final 도착. 단순히 t0 이후 첫 이벤트로 대체하지 않음 |
| t2 first discriminative partial | 그 시점까지 도착한 text만으로 사전 정의된 안전 evidence 기준을 처음 충족 |
| t3 stable discriminative partial | 동일 evidence가 사전 정의한 연속 업데이트/기간 조건을 처음 충족. 나중 final을 소급 사용하지 않음 |
| t4 final result | 해당 evidence가 속한 ASR utterance의 final 도착. Cue별 final을 특정할 수 없으면 그 한계를 명시 |
| t5 shadow cue trigger | 기존 안전 정책하에서 엔진이 실제 trigger한 이벤트 수신 시점 |

`t1−t0`, `t2−t0`, `t3−t0`, `t4−t0`, `t5−t0`와 구간별 `t2−t1`, `t3−t2`, `t5−t3`를 측정한다. 경로에 없는 시점은 null이며 0으로 채우지 않는다. Median/P95마다 n과 전체 27개 대비 coverage를 함께 표시한다. Candidate 정체로 막힌 시간과 evidence 자체 획득 시간을 분리하고, word-end 이전 이득은 독립 검토된 acoustic word-end와 비교한다.

### D. Revision/false-trigger 평가 바로잡기

모든 원문 partial, 이전 text, 도착 시각, 유지 시간, 추가/삭제/치환을 보존한다. Append-only 확장, 같은 오디오 범위의 의미 수정, window eviction, utterance 경계 전환을 별도 집계한다. “이후 evidence가 취소됨”과 “잘못된/너무 이른 cue trigger”는 서로 다른 지표다.

Unsafe 판정의 허용 오차·분모를 먼저 정한다. 예를 들어 검토된 cue onset보다 허용 오차 이상 앞선 trigger, 다른 cue/다른 반복 회차로의 trigger를 구분한다. 애매한 cue는 review-required로 남긴다. Immediate/stable을 동일 이벤트로 비교하되 stable 때문에 발생한 miss도 함께 보고한다.

### E. 첫 정체 원인과 다음 병목 분석

Immediate C033, stable C020 직전의 실제 text/revision/cursor/matcher reason을 살핀다. Acoustic recognition, consumed evidence, anchor 유지 조건, 후보 진입, 희소 final 중 어떤 원인인지 근거를 남긴다. 특정 cue hardcoding, 자동 NEXT, reference 기반 시각 trigger로 결과를 맞추지 않는다.

현재 예상되는 성능 병목은 약 1초가 걸리는 반복 12초 window 추론과 update/revision 구조다. 원인을 확인한 뒤에만 후속 최적화 범위를 정한다. 비교는 동일 오디오·동일 onset 기준·동일 cue 집합에서 paired 결과 및 miss를 함께 사용한다. 성공한 일부 cue만 골라 과거 27개 replay의 평균과 비교하지 않는다.

### F. 검증 후 결과 고정

새 annotation/분석 테스트, revision/window-eviction/반복 가사/최초 정체 회귀 테스트를 추가한다. 실제 1.0x 재실행이 필요하면 새 run 디렉터리를 사용하고 원본 SHA, 공급 lag, RTF 정의를 다시 기록한다. 기존 PERFORMANCE_LOCAL과 saved-replay 정책은 변경하지 않는다. Commit/push는 별도 사용자 요청에 따라 소스·테스트·비밀 없는 보고서만 선별한다.

## 11. 실행과 테스트

저장소 루트에서 일반 명령:

```bash
npm install
npm run dev
npm run dev:backend
npm test
npm run typecheck
npm run build
npm run test:backend
npm run test:e2e
```

새 머신의 Python 준비는 README를 따른다. 기존 머신에서는 이미 준비된 `.venv`를 불필요하게 재생성하지 않는다. 설치 버전은 위 실측 버전을 기준으로 재현하고, 모델을 repository 안에 넣지 않는다.

실제 streaming capture 재실행(약 226초 + 로딩/drain; frontend 불필요):

```bash
cd services/audio-engine
.venv/bin/python -m app.streaming_measurement \
  --audio '../../recordings/decadence-gyeongseong/R001/M05-2/M5-2_외로운별 _0420.wav'
```

Harness가 별도 ephemeral loopback backend를 직접 시작한다. 일반 backend 서버를 따로 켤 필요가 없다. `--output` 생략 시 새 UUID 디렉터리를 만든다.

새 capture의 분석(루트에서; 기존 분석이 없는 새 run에만):

```bash
node scripts/analyze-streaming-measurement.mjs \
  .stage-data/streaming-measurements/run-NEW-ID/capture.json
```

기존 saved replay 회귀:

```bash
npm run rehearsal:replay-check -- --policy baseline
npm run rehearsal:replay-check -- --policy discriminative-words
```

문서 작성 시 **현재 미커밋 소스 포함 재실행한 결과**:

| 검증 | 2026-09-22 결과 |
| --- | --- |
| `npm test` | 200 PASS / 17 files |
| `npm run typecheck` | PASS |
| `npm run test:backend` | 80 PASS / 1 SKIP, dependency deprecation warning 2개 |
| `git diff --check` | PASS; untracked 파일 검증까지 의미하지는 않음 |
| build / E2E | 이번 문서 작업에서는 재실행 안 함; 마지막 full 검증은 60a0e62 freeze |

Backend skip은 별도 모델/오디오 환경변수가 필요한 선택적 integration test다. 전체 226초 실제 모델 run의 성공과 unit/mock 테스트 통과는 별개의 근거다. Synthetic E2E 성공도 live latency 실측을 대신하지 않는다.

Next dev/build가 `apps/web/next-env.d.ts`의 generated route type 경로를 바꿀 수 있다. 무관한 생성물 diff를 기능 변경과 섞지 말고 실제 차이를 확인한다.

## 12. 읽을 문서와 최종 보고 기준

읽는 순서:

1. 이 문서 → [README](../README.md) → 해당 디렉터리 Agent 지침.
2. [saved replay freeze 보고서](recording-replay-early-evidence-report.md).
3. 위 5개 streaming 소스 → 실제 `capture.json` / `shadow-analysis.json`.
4. 필요할 때 [recording replay v2](recording-replay-v2-report.md), [M05-2 구현](m05-2-report.md), [Groq 배치 분석](groq-rehearsal-report.md).

오래된 문서의 “모델 unavailable”, “아직 실제 streaming 미실행”은 당시 상태다. 현 소스/현 artifact와 확인 날짜를 우선하되, 이 문서의 수치도 새로운 측정 없이 갱신하지 않는다.

후속 milestone 최종 보고는 하드웨어, 모델/버전, 정확한 RTF 분모, 27 cue correct/wrong/miss 및 review-required, t1/t2/t3/t5 median/P95와 n, revision/evidence cancellation/unsafe trigger의 구분, completed-word 대비 유효한 개선폭, 다음 병목을 포함한다. 근거가 없는 항목은 N/A와 이유를 쓴다.

### 다음 Agent에게 바로 전달할 작업 지시

> 먼저 로컬 60a0e62와 미커밋 streaming 코드 5개, 기존 226초 capture를 읽어라. Saved-ASR replay milestone은 완료되었으므로 다시 설계하지 말라. 기존 공연 안전 정책과 fallback OFF를 유지한 채 독립 audio onset annotation 검증/분석 경로, t0–t5 정의, revision과 rolling-window eviction 구분을 완성하라. Immediate C033 / stable C020 정체를 실제 trace로 진단하라. 독립 정답이 없으면 요청하고 latency·false-trigger 수치를 만들지 말라. 외부 ASR, microphone/speaker/BlackHole, 관객 송출, 임의 push는 하지 말라. 원본과 기존 artifact를 보존하고 필요한 테스트와 다음 실험 계획을 보고하라.
