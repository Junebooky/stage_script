# Groq 리허설 구현·검증 보고서

실제 요청: 2026-09-13, 검토 정리: 2026-09-14. 구현 기준: 사용자 제공 `ref_new_md` 및 이후 승인한 Free Tier 16kHz mono FLAC 전송 조건. 기존 공연 runtime과 canonical은 보존했습니다.

## 결과와 실행 경계

Groq `whisper-large-v3` 녹음 분석 provider, 공통 선택·동의 경계, nullable confidence, 감사 기록, benchmark/22항목 보고서 생성기를 구현했습니다. 기본 리허설은 Groq, 대안은 Soniox stt-async-v5/준비된 Local ASR입니다. Live online은 Browser Web Speech, live offline은 Local ASR만 사용합니다. Groq를 실시간 공연 ASR로 연결하지 않았습니다.

사용자가 제공한 키는 서버 전용 `services/audio-engine/.env.local`에 저장했고 파일 권한은 600입니다. Git ignore 적용을 확인했습니다. 키 값은 이 보고서/소스/브라우저/테스트에 넣지 않았습니다. 서버 환경변수가 파일보다 우선하며 테스트·CI에서는 파일을 로드하지 않습니다. 대화에 노출된 키는 별도로 회전하는 것을 권장합니다. 승인된 실제 요청은 HTTP 200으로 성공했습니다.

**실제 M05-2 Groq 요청 1회가 성공했습니다.** 이전 전송 승인 대기는 해소됐습니다. 새 승인 조건에 맞춰 원본 업로드/재시도 경로를 제거하고 임시 16kHz mono FLAC의 크기·재생시간·offset을 먼저 검증했습니다. 8,200,147 bytes만 전송했고 원본은 전송하지 않았습니다. 후속 검토는 저장된 응답만 사용했으며 API를 다시 호출하지 않았습니다.

## 실제 원본 검사

원본: `recordings/decadence-gyeongseong/R001/M05-2/M5-2_외로운별 _0420.wav`

이번 실제 분석 artifact 디렉터리(로컬 전용/Git 제외):

```text
.stage-data/number-analysis/run-167571f2-8599-40db-9f76-b24dcf08c5c9/
  inspection.json
  status.json       # ASR COMPLETE, realASRRan=true
  run.json
  observation.json
  external-asr.json
  alignment.json
  metrics.json
  candidate-profile.json
  asr-benchmark.json
  report.md         # 자동 생성 22항목 보고서
  verification-report.md  # 원응답/정렬/전송 검증과 한계 해설
```

- 65,213,494 bytes / 226,138.479 ms / 48,000 Hz / stereo / 24-bit PCM
- 10,854,647 frames 전체 디코딩 성공
- SHA-256 전후 동일: `2b7ce5887f92a5527f4dca1564d00aa2c95eb834ca2e0d6d06189b4588cdb5e7`
- 원본 이동·개명·변경 없음. M05-2 canonical 36 cues 변경 없음.
- 변환본: 16,000 Hz / mono / 24-bit FLAC, 8,200,147 bytes (<25,000,000).
- 원본 226,138.479166667 ms → FLAC 226,138.5 ms. 차이 +0.020833333 ms로 1출력샘플(0.0625 ms) 이내입니다. 두 타임라인 offset=0, 전체 decode 성공. 재생시간이 수학적으로 완전히 같다고 주장하지 않습니다.
- Trimming/tempo change/silence removal/MP3/AAC/chunking 없음. 임시 FLAC 삭제 완료.
- 이전 검사 전용 `run-08e7f8ef-ce0f-4b76-b0b5-577a301cf819`도 그대로 보존했습니다.

## 실제 데이터 지표 상태

| 항목 | 현재 근거 |
| --- | --- |
| 실제 모델 | Groq `whisper-large-v3`; HTTP 200, 1회 |
| ASR segment / word | 원응답 24 / 129; 정규화에 채택된 word 95개(19개 span), confidence=null |
| Cue alignment / coverage | 기계 배정 28/36 (77.78%); 인간 정답 정확도가 아님 |
| Review-required / missed cues | 검토 8개 / 미관측 8개, 별도 경고 2개 |
| C001–004 vs C018–021 반복 | 순서 문맥으로 서로 다른 occurrence에 배정; C003/C019 시각은 검토 필요 |
| A→B / B→C | B 대사 대부분 미관측, 두 전환 모두 검토 필요 |
| 합창·듀엣 | C030/031/032/035/036 배정; C032 시각, C035 전사/정렬 검토 필요 |
| Matcher before/after | 기준/프로필 적용 후보 모두 C001–008 자동 8회, 평가 대상 26 중 누락 18; 개선 없음 |
| Candidate Cue Profile | 36개 cue profile 생성, sampleCount=1, fallback OFF, Champion 승격 없음 |
| 배치 요청 wall time | 3,318.611 ms; 변환 포함 provider pipeline 3,637.951 ms |
| Live end-to-end latency | 미측정; 배치 시간과 분리 |
| 최고 성능 / production ready | 주장하지 않음 |

미관측: C009–C015, C017. 검토: C003, C008, C016, C019, C022, C023, C032, C035. 경고: C024, C027. 모든 ID의 접두사는 M05-2_입니다. C016은 B 위치가 아니라 마지막 223.709초의 인사에 연결됐으므로 오정렬 의심입니다. 28개 기계 배정을 28개 정답으로 세면 안 됩니다.

Whole-segment UNMATCHED_SPEECH queue는 0개지만 부분 미매칭 텍스트 1개가 별도로 발견됐습니다(groq-6의 54.600–64.100초 span 안). 현재 queue는 문장 일부의 잔여 텍스트까지 포괄하지 않습니다. 이것이 애드리브라는 뜻은 아닙니다. B가 실제 녹음에 빠졌는지 ASR이 놓쳤는지는 원본 청취로 확인해야 합니다.

기준/후보의 replay는 같은 엔진에 프로필 적용 여부만 다르며 별도 개선 알고리즘을 성능이 좋아지도록 꾸며 넣지 않았습니다. 둘 다 evaluatedCues=26, missed=18, wrong=0, early=0, late=6, manual=0, fallback=0입니다. 참고용 simulated-asr-delivery P50=2,910ms, P95=3,840ms는 실제 live latency가 아닙니다. C009를 기다리는 next-only 정책 때문에 C018로 건너뛰지 않았습니다. 반복 혼동 카운트 0도 C구간 자동 송출 성공을 의미하지 않습니다.

22항목 보고서는 실제 생성된 결과를 읽으며 WER/CER·인간 정답·live latency를 만들어 넣지 않습니다. 원응답 전체 단어는 129개지만 경계 불일치/겹침으로 5개 span의 34개 단어는 정렬에 채택하지 않아 자동 보고서의 wordCount는 95입니다. 원 시각은 rawResult에 그대로 보존했습니다.

## API·데이터 처리

고정 endpoint `https://api.groq.com/openai/v1/audio/transcriptions`, 한국어, temperature 0, verbose_json, word+segment timestamps를 요청합니다. Canonical 문구·cue ID·앵커·prompt는 전송하지 않습니다. 공급자에게 전달하는 파일명은 generic 이름입니다. 인증/속도 제한/timeout/5xx에는 자동 재시도나 provider fallback이 없습니다. 키/헤더/공급자의 원문 오류를 예외와 감사 기록에 노출하지 않으며 예상 밖 응답의 키 값도 제거합니다. [Groq STT 명세](https://console.groq.com/docs/speech-to-text).

Free Tier를 기준으로 FFmpeg 임시 16kHz mono FLAC을 먼저 만듭니다. 원본 변경·시간 편집 없이 전체 decode, 출력 형식, 원본과 재생시간 차이 1출력샘플 이내, offset 0, 25,000,000 bytes 이하를 검증한 뒤에만 전송합니다. FLAC은 변환된 PCM의 lossless 압축이며 리샘플링/downmix가 원본 waveform과 동일하다는 뜻은 아닙니다. 성공/실패 모두 임시 파일을 정리하고 원본 hash를 검사합니다. 한도 초과 또는 실패 시 즉시 중단하며 자동 재시도/fallback/chunking은 없습니다. 이번에는 분할이 필요하지 않았습니다.

단어 confidence 미제공은 `null/unavailable`입니다. Segment `exp(avg_logprob)`는 `segment-logprob-derived`이며 단어 native confidence와 구별합니다. 누락 acoustic score 항은 제외하고 나머지 가중치를 재정규화합니다. 정렬 observation은 `text-sequence-only` 여부를 남깁니다. 낮은 acoustic evidence/높은 no_speech_prob는 검토로 보내며 모든 자동 시각은 pseudo입니다. 불일치하거나 겹치는 단어 시각은 수정해 맞추지 않고 rawResult에 보존합니다.

Groq 전사는 파일 전체의 외부 처리입니다. 이 endpoint에는 앱이 호출할 원격 삭제 기능이 없으며 zero-retention이나 처리 국가를 보장하지 않습니다. 보관 예외와 조직 설정은 [Groq 데이터 정책](https://console.groq.com/docs/your-data)을 확인해야 합니다. Soniox의 기존 원격 job/file 삭제 요청은 그대로 유지했습니다.

## 검증

| 검증 | 결과 |
| --- | --- |
| `npm test` | 130 passed / 13 files |
| `npm run typecheck` | 통과 |
| `npm run build` | Next.js 프로덕션 빌드 통과 |
| `npm run test:backend` | 58 passed, 1 skipped |
| `npm run test:e2e` | 이전 UI 검증 28 passed; 이번 변경은 transport/backend 및 문서 |
| `git diff --check` | 통과 |
| 실제 WAV inspect-only | 전체 decode, 원본 SHA 불변 |
| 비밀값 검사 | 공개 소스·빌드 파일 830개에서 설정 키 노출 없음; canonical SHA가 HEAD와 일치 |
| 브라우저 시각 확인 | Rehearsal 기본 Groq/동의 잠금, 홈→Operator, 오류 overlay 없음, 가로 overflow 없음 |

Backend skip은 별도 사전 준비 로컬 모델/오디오가 필요한 실제 ASR 통합 테스트입니다. HTTP 모의 테스트에 Groq 실제 키나 비공개 원본은 사용하지 않았습니다. Backend TestClient의 upstream deprecation 경고 2건은 남아 있습니다. E2E는 sandbox 로컬 접근 제한으로 최초 실행이 막혔고 승인된 로컬 테스트 재실행에서 통과했습니다.

검증 범위: 기존 UI 선택·동의 → HTTP payload → provider 모의 multipart 응답 → 정렬/저장 → human review → 후보 생성/승격 차단. 추가로 실제 Groq HTTP 200, 원본 불변·임시 전송본 검증/정리, 실제 응답 정렬/replay를 확인했습니다. 실제 음향 정답과 live 품질은 아직 인간 검증이 필요합니다. 이전 브라우저/환경변수 스킬 검증에 따라 키 저장은 서버로 한정돼 있습니다.

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
services/audio-engine/app/adapters/groq_transport.py
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

로컬 전용: `services/audio-engine/.env.local`, 위 실제 분석 및 검사 전용 `.stage-data/` 결과. 키·원본 오디오·`ref_new_md`·reference 문서는 Git에서 제외합니다. M05-2 canonical JSON은 수정하지 않았습니다. 위 파일 목록은 최초 Groq 구현과 이번 Free Tier 확장의 누적 목록입니다.

## 이어서 할 일

1. B 대사가 이 녹음에 포함되는지, 마지막 인사가 C016과 다른 문맥인지 확인합니다. 원본/확정 대본은 자동 수정하지 않습니다.
2. 실제 22항목 보고서와 원본을 함께 검토해 반복 오프닝, 대사/가창 전환, 합창, 미관측·오정렬·내부 앵커를 판정합니다.
3. 같은 오디오 SHA로 Soniox/Local 결과를 비교하고 별도 리허설·인간 정답으로 과적합을 검증합니다. 한 녹음을 여러 독립 표본으로 세지 않습니다.
4. 실제 live 장비에서 end-to-end 지연, 오송출, 누락, 수동 개입을 별도로 측정한 뒤 운영자가 승격을 결정합니다.
