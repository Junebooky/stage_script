# Groq 리허설 구현·검증 보고서

검증일: 2026-09-13. 구현 기준: 사용자 제공 `ref_new_md`. 기존 공연 runtime과 canonical은 보존했습니다.

## 결과와 실행 경계

Groq `whisper-large-v3` 녹음 분석 provider, 공통 선택·동의 경계, nullable confidence, 감사 기록, benchmark/22항목 보고서 생성기를 구현했습니다. 기본 리허설은 Groq, 대안은 Soniox stt-async-v5/준비된 Local ASR입니다. Live online은 Browser Web Speech, live offline은 Local ASR만 사용합니다. Groq를 실시간 공연 ASR로 연결하지 않았습니다.

사용자가 제공한 키는 서버 전용 `services/audio-engine/.env.local`에 저장했고 파일 권한은 600입니다. Git ignore 적용을 확인했습니다. 키 값은 이 보고서/소스/브라우저/테스트에 넣지 않았습니다. 서버 환경변수가 파일보다 우선하며 테스트·CI에서는 파일을 로드하지 않습니다. 대화에 노출된 키는 별도로 회전하는 것을 권장합니다. 키의 실제 API 유효성은 아직 검증하지 않았습니다.

**실제 M05-2 Groq 요청은 실행되지 않았습니다.** 도구 안전 검토가 이 특정 비공개 WAV의 외부 전송 승인을 요구하여 프로세스 시작 전에 거절했습니다. 우회하지 않았고 사용자에게 파일 경로·크기·목적지·FLAC 재시도 조건을 제시해 승인을 요청했습니다. 따라서 Groq 실측 모델/전사/정렬/후보 결과는 없으며 아래 합성 테스트 결과를 실제 음향 성능으로 해석하면 안 됩니다.

## 실제 원본 검사

원본: `recordings/decadence-gyeongseong/R001/M05-2/M5-2_외로운별 _0420.wav`

이번 검사 전용 artifact 디렉터리:

```text
.stage-data/number-analysis/run-08e7f8ef-ce0f-4b76-b0b5-577a301cf819/
  inspection.json
  status.json       # INSPECTION ONLY, realASRRan=false
  run.json
```

- 65,213,494 bytes / 226,138.479 ms / 48,000 Hz / stereo / 24-bit PCM
- 10,854,647 frames 전체 디코딩 성공
- SHA-256 전후 동일: `2b7ce5887f92a5527f4dca1564d00aa2c95eb834ca2e0d6d06189b4588cdb5e7`
- 원본 이동·개명·변경 없음. M05-2 canonical 36 cues 변경 없음.
- Groq 실제 분석 디렉터리: 아직 없음. 검사 전용 디렉터리는 ASR 결과가 아닙니다.

## 실제 데이터 지표 상태

| 항목 | 현재 근거 |
| --- | --- |
| 요청 예정 모델 | Groq `whisper-large-v3`; 실제 요청 미실행 |
| Cue alignment / coverage | 미측정 |
| Review-required / missed cues | 실제 전사 없으므로 미산출 |
| C001–004 vs C018–021 반복 | 실제 녹음 미평가; 합성 순서/고립 반복/두 번째 시작 회귀 테스트 통과 |
| A→B / B→C / 합창·듀엣 / 내부 앵커 | 실제 녹음 미평가; 보고서에 별도 항목 구현 |
| Matcher before/after | 실제 결과 없음; 동일 엔진 replay 비교 생성기 구현 |
| Candidate Cue Profile | 실제 candidate 미생성, Champion 변경 없음 |
| 배치 wall time | 미측정 |
| Live end-to-end latency | 미측정; 배치 시간과 분리 |
| 최고 성능 / production ready | 주장하지 않음 |

승인 후 CLI는 새 UUID 디렉터리에 `observation.json`, `alignment.json`, `metrics.json`, `external-asr.json`, `asr-benchmark.json`, `report.md`를 생성합니다. 정렬 근거가 있을 때만 `candidate-profile.json`을 추가하며 한 녹음의 후보는 sampleCount=1, candidate, fallback OFF, 자동 승격 없음입니다. 22항목 보고서는 실제 생성된 결과를 읽으며 WER/CER·인간 정답·live latency를 만들어 넣지 않습니다.

## API·데이터 처리

고정 endpoint `https://api.groq.com/openai/v1/audio/transcriptions`, 한국어, temperature 0, verbose_json, word+segment timestamps를 요청합니다. Canonical 문구·cue ID·앵커·prompt는 전송하지 않습니다. 공급자에게 전달하는 파일명은 generic 이름입니다. 인증/속도 제한/timeout/5xx에는 자동 재시도나 provider fallback이 없습니다. 키/헤더/공급자의 원문 오류를 예외와 감사 기록에 노출하지 않으며 예상 밖 응답의 키 값도 제거합니다. [Groq STT 명세](https://console.groq.com/docs/speech-to-text).

원본 전송이 크기 제한으로 거절된 경우에만 FFmpeg lossless FLAC 임시 전송본을 만들고 한 번 재시도합니다. Sample rate/channel/timeline을 유지하고 원본 hash를 다시 검사합니다. 성공/실패 모두 임시 파일을 정리합니다. FLAC도 제한에 걸리면 중단합니다. 정확한 sample-offset chunking은 아직 구현하지 않았고 필요 여부도 실제 요청 전에는 확인되지 않았습니다.

단어 confidence 미제공은 `null/unavailable`입니다. Segment `exp(avg_logprob)`는 `segment-logprob-derived`이며 단어 native confidence와 구별합니다. 누락 acoustic score 항은 제외하고 나머지 가중치를 재정규화합니다. 정렬 observation은 `text-sequence-only` 여부를 남깁니다. 낮은 acoustic evidence/높은 no_speech_prob는 검토로 보내며 모든 자동 시각은 pseudo입니다. 불일치하거나 겹치는 단어 시각은 수정해 맞추지 않고 rawResult에 보존합니다.

Groq 전사는 파일 전체의 외부 처리입니다. 이 endpoint에는 앱이 호출할 원격 삭제 기능이 없으며 zero-retention이나 처리 국가를 보장하지 않습니다. 보관 예외와 조직 설정은 [Groq 데이터 정책](https://console.groq.com/docs/your-data)을 확인해야 합니다. Soniox의 기존 원격 job/file 삭제 요청은 그대로 유지했습니다.

## 검증

| 검증 | 결과 |
| --- | --- |
| `npm test` | 130 passed / 13 files |
| `npm run typecheck` | 통과 |
| `npm run build` | Next.js 프로덕션 빌드 통과 |
| `npm run test:backend` | 54 passed, 1 skipped |
| `npm run test:e2e` | 28 passed |
| `git diff --check` | 통과 |
| 실제 WAV inspect-only | 전체 decode, 원본 SHA 불변 |
| 비밀값 검사 | 공개 소스·빌드 파일 830개에서 설정 키 노출 없음; canonical SHA가 HEAD와 일치 |
| 브라우저 시각 확인 | Rehearsal 기본 Groq/동의 잠금, 홈→Operator, 오류 overlay 없음, 가로 overflow 없음 |

Backend skip은 별도 사전 준비 로컬 모델/오디오가 필요한 실제 ASR 통합 테스트입니다. HTTP 모의 테스트에 Groq 실제 키나 비공개 원본은 사용하지 않았습니다. Backend TestClient의 upstream deprecation 경고 2건은 남아 있습니다. E2E는 sandbox 로컬 접근 제한으로 최초 실행이 막혔고 승인된 로컬 테스트 재실행에서 통과했습니다.

검증 범위: UI 선택·동의 → HTTP payload → provider의 모의 multipart 응답 → 정렬/저장 → human review → 후보 생성/승격 차단. Groq 실서비스와 실제 음향 품질 경계는 승인 대기로 미검증입니다. 브라우저/환경변수 스킬에 따라 화면에서 동작을 확인하고 키 저장을 서버로 한정했습니다.

CI workflow를 추가했습니다. 위 결과는 로컬 검증이며 GitHub hosted check 결과는 push 이후 별도로 확인해야 합니다. CI에는 private key/audio 의존성이 없습니다.

## 정확한 변경 파일

신규:

```text
.github/workflows/ci.yml
data/asr-providers.json
docs/groq-rehearsal-report.md
packages/rehearsal/src/benchmark.ts
services/audio-engine/.env.example
services/audio-engine/app/adapters/groq.py
services/audio-engine/app/environment.py
services/audio-engine/app/rehearsal_providers.py
services/audio-engine/tests/test_environment.py
services/audio-engine/tests/test_groq.py
```

수정:

```text
.gitignore
README.md
apps/web/components/RehearsalWorkspace.tsx
docs/architecture.md
docs/implementation-report.md
packages/alignment/src/index.ts
packages/rehearsal/src/alignment.ts
packages/rehearsal/src/index.ts
packages/rehearsal/src/m05-2.test.ts
packages/rehearsal/src/number-alignment.ts
packages/rehearsal/src/replay.ts
packages/rehearsal/src/types.ts
packages/script-engine/src/index.ts
scripts/rehearsal-analyze.mjs
services/audio-engine/app/adapters/local.py
services/audio-engine/app/adapters/soniox.py
services/audio-engine/app/main.py
services/audio-engine/app/rehearsal.py
services/audio-engine/app/rehearsal_cli.py
services/audio-engine/pyproject.toml
services/audio-engine/tests/test_inspection.py
services/audio-engine/tests/test_rehearsal.py
services/audio-engine/tests/test_soniox.py
tests/e2e/m05-2.spec.ts
tests/e2e/rehearsal-workflow.spec.ts
```

미사용 import/참조 확인 후 삭제한 파일(Git 이력에서 복구 가능):

```text
apps/web/components/DemoExperience 2.tsx
apps/web/components/HologramAvatar 2.tsx
apps/web/app/globals 2.css
```

로컬 전용: `services/audio-engine/.env.local`, 위 검사 전용 `.stage-data/` 결과. 키·원본 오디오·`ref_new_md`·reference 문서는 Git에서 제외합니다. M05-2 canonical JSON은 수정하지 않았습니다.

## 이어서 할 일

1. 해당 M05-2 녹음의 Groq 전송 승인을 받은 후 실전사를 한 번 실행합니다. 원본 크기 거절 시에만 lossless FLAC 재시도, 그것도 실패하면 정확한 offset 분할을 구현·검증합니다.
2. 실제 22항목 보고서와 원본을 함께 검토해 반복 오프닝, 대사/가창 전환, 합창, 미관측·오정렬·내부 앵커를 판정합니다.
3. 같은 오디오 SHA로 Soniox/Local 결과를 비교하고 별도 리허설·인간 정답으로 과적합을 검증합니다. 한 녹음을 여러 독립 표본으로 세지 않습니다.
4. 실제 live 장비에서 end-to-end 지연, 오송출, 누락, 수동 개입을 별도로 측정한 뒤 운영자가 승격을 결정합니다.
