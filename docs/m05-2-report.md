# M05-2 구현·검증 보고서

2026-09-13 · ref.md 78번의 19개 보고 항목. 최신 사용자 요청에 따라 로컬 모델 준비는 미루고 기존 브라우저 ASR과 외부 Soniox 경로를 추가했다. **실제 녹음의 ASR 분석은 아직 실행하지 않았다.** 아래 합성 회귀 결과와 실제 파일 검사를 구분한다.

## 1. 발견한 기존 문제

실제 Operator/Rehearsal 기본값이 합성 16-cue demo였고 production registry가 없었다. 알려진 넘버도 전체 공연 global alignment를 거쳤다. 반복 가사 문맥, 단일 녹음의 분포 한계, 단어 시각 없는 latency의 불확실성이 충분히 드러나지 않았다. 로컬 모델 부재로 실시간 공연 입력과 리허설 분석이 막혔다. 문서의 WAV 경로도 실제 파일 위치와 달랐다.

## 2. 주요 구조 변경

Registry의 단일 defaultNumberId → M05-2 canonical → 서버에서 catalog 로드 → Operator/Rehearsal에 전달한다. ASR은 canonical을 수정하지 않는다. 선택 넘버 내부 정렬, 반복 sequence 문맥, 관측/검토, 후보/기본 기준 비교, show+number별 프로필 보관을 연결했다.

Next.js/React 스킬의 서버·클라이언트 경계 및 상태 격리 지침을 적용했다. 파일시스템 loader는 서버 전용이고 대본/넘버/입력 교체는 keyed runtime으로 분리한다. 사용자 import를 보존하며 브라우저 저장 실패 시 현재 세션은 유지하고 경고한다.

기본 실시간 입력은 ONLINE PREVIEW: 기존 브라우저 interim ASR, 설치·키 없이 시연. 외부 리허설 후보는 Soniox stt-async-v5: 서버 키와 전송 동의가 필요하다. LOCAL 입력은 별도 선택으로 보존하고 자동 cloud fallback은 없다. 기존 membrane 3D는 이번 변경에서 다시 디자인하지 않았다.

## 3. 주요 추가·변경 파일

| 범위 | 파일 |
| --- | --- |
| 실제 대본·등록 | data/productions/registry.json, decadence-gyeongseong/numbers/M05-2.json |
| 검증 loader/schema | packages/script-schema/src/production.ts, production-types.ts, index.ts, production.test.ts |
| 관측·보정·비교 | packages/rehearsal/src/number-alignment.ts, alignment.ts, calibration.ts, comparison.ts, replay.ts, types.ts, m05-2.test.ts |
| 웹 화면·입력 | app/page.tsx, app/operator/page.tsx, app/rehearsal/page.tsx, ProductionSelector.tsx, OperatorExperience.tsx, RehearsalWorkspace.tsx, use-performance-session.ts, use-browser-performance-asr.ts, use-microphone.ts, show-storage.ts, globals.css |
| 원본 검사·ASR | services/audio-engine/app/inspection.py, rehearsal_cli.py, rehearsal.py, adapters/soniox.py |
| 재현 CLI·검증 | scripts/rehearsal-analyze.mjs, package.json/lock, pyproject.toml, tests/e2e/m05-2.spec.ts, backend test_inspection.py/test_soniox.py/test_rehearsal.py |
| 문서·보호 | README.md, docs/architecture.md, docs/m05-2-work-log.md, 본 보고서, .gitignore |

기존 변경분/삭제된 ref.tsx/사용자 PDF·참조 문서는 복구·덮어쓰기하지 않았다. 원본 오디오는 Git에서 제외했다.

## 4. M05-2 canonical cue 분할

36개: A 가창 8개, B 대사 9개, C 가창 19개. ID는 M05-2_C001…C036. user 제공 문장·배우·순서를 유지했다. C014는 같은 배우의 이어지는 한 문장으로 묶었다. 아래 <br>은 표시 줄바꿈일 뿐 단어 수정이 아니다.

단독은 CAPTION, 같은 가사를 함께 부르는 듀엣·합창은 CHORUS로 한 번 표시한다. 서로 다른 동시 가사가 제공되지 않았으므로 OVERLAP을 만들기 위해 대본을 복제하지 않았다. 기존 서로 다른 OVERLAP 출력 회귀는 유지한다. 마지막 반주 종료는 metadata일 뿐 IMAGE/가짜 자막으로 만들지 않았다. act-1은 이 녹음 범위의 조직용 컨테이너이며 전체 공연 막 구성의 검증을 뜻하지 않는다.

| ID | 구간 / 발화 | 배우 | 확정 자막 |
| --- | --- | --- | --- |
| M05-2_C001 | A / sung | 연홍 | 창가로 스며드는 외로운 저 달빛 |
| M05-2_C002 | A / sung | 연홍 | 지금 어딘가 그대도 보고 있나 |
| M05-2_C003 | A / sung | 연홍 | 내 성을 맴돌던 그대의 그림자 |
| M05-2_C004 | A / sung | 연홍 | 어서 내 문을 지금 두드려 줘요 |
| M05-2_C005 | A / sung | 조상 | 우리를 갈라 놓은 세상 |
| M05-2_C006 | A / sung | 조상 | 끔찍하게 멀어져 버린 사랑 |
| M05-2_C007 | A / sung | 연홍 | 이별은 없는 것 |
| M05-2_C008 | A / sung | 연홍 | 돌아와요 내 품이 매일 그댈 기다리니 |
| M05-2_C009 | B / spoken | 세련 | 와, 잘하는데! |
| M05-2_C010 | B / spoken | 연홍 | 정말이요? 그렇게 이야기 해주시니 너무 기뻐요. |
| M05-2_C011 | B / spoken | 세련 | 노래는 내가 직접 가르쳐줄 거니까, |
| M05-2_C012 | B / spoken | 세련 | 엄마 몰래 언제든지 극장에 놀러와. |
| M05-2_C013 | B / spoken | 연홍 | 진짜요 선생님? |
| M05-2_C014 | B / spoken | 세련 | 그렇고 말고, 이제 선생님 말고 이모라 불러. |
| M05-2_C015 | B / spoken | 세련 | 아니 언니라고 생각해도 괜찮아. |
| M05-2_C016 | B / spoken | 연홍 | 감사합니다. |
| M05-2_C017 | B / spoken | 조상 | 이번에는 가슴 벅찬 템포로 다시 가 볼게요! |
| M05-2_C018 | C / sung | 연홍 | 창가로 스며드는 외로운 저 달빛 |
| M05-2_C019 | C / sung | 연홍 | 지금 어딘가 그대도 보고 있나 |
| M05-2_C020 | C / sung | 연홍 | 내 성을 맴돌던 그대의 그림자 |
| M05-2_C021 | C / sung | 연홍 | 어서 내 문을 지금 두드려 줘요 |
| M05-2_C022 | C / sung | 조상 | 저 높은 창가 내겐 닿을 수 없는 곳 |
| M05-2_C023 | C / sung | 조상 | 어떻게 감히 그댈 넘볼 수 있나 |
| M05-2_C024 | C / sung | 조상 | 만나서는 안 될 궂은 운명에도 |
| M05-2_C025 | C / sung | 조상 | 이미 멈출 수 없던 사랑의 시작 |
| M05-2_C026 | C / sung | 연홍 | 내게로 와요 |
| M05-2_C027 | C / sung | 연홍 | 걱정말고 제가 열쇠를 건네드릴 테니 |
| M05-2_C028 | C / sung | 조상 | 잠들지 말아요 |
| M05-2_C029 | C / sung | 조상 | 동이트기 전에 그댈 향해 달려갈 테니 |
| M05-2_C030 | C / sung | 조상 + 연홍 + 전체합창 | 외로운 별이여 잠시 쉬어 가게 |
| M05-2_C031 | C / sung | 조상 + 연홍 + 전체합창 | 이 밤을 포근히 품어 주소서 |
| M05-2_C032 | C / sung | 조상 + 연홍 + 전체합창 | 아득한 달이여 어서 길을 비춰 주오 |
| M05-2_C033 | C / sung | 조상 | 어두운 숲이여 |
| M05-2_C034 | C / sung | 연홍 | 길을 열어 주오 |
| M05-2_C035 | C / sung | 조상 + 연홍 | 우리 잠시 이 밤을 틈타 만날 수 있게 |
| M05-2_C036 | C / sung | 모두 함께 | 창가로 스며드는 운명의 별이여 |

## 5. 실제 WAV 메타데이터

문서의 경로는 없고, 실제 원본은 `recordings/decadence-gyeongseong/R001/M05-2/M5-2_외로운별 _0420.wav`이다. R001과 파일명 공백을 그대로 유지했다.

| 항목 | 실제 검사 |
| --- | --- |
| 크기 | 65,213,494 bytes |
| 길이 | 226.138479초 (3분 46.138초) |
| 형식 | WAV / pcm_s24le / 24-bit integer PCM |
| 샘플레이트·채널 | 48,000 Hz / stereo, 2 channels |
| 프레임 | 10,854,647 / 전체 디코딩 성공 |
| 정규화 절대 peak | 0.988499999 |
| SHA-256 전후 | 2b7ce5887f92a5527f4dca1564d00aa2c95eb834ca2e0d6d06189b4588cdb5e7 |

Python stdlib 전체 PCM 검사와 ffprobe 메타데이터/ffmpeg 전체 decode가 성공했다. 원본을 변환·분할·이동·개명·덮어쓰지 않았다.

## 6. ASR 상태와 모델 선택

로컬: faster-whisper 패키지와 STAGE_LOCAL_MODEL_DIR 모델 없음. LOCAL ASR UNAVAILABLE. 최신 요청에 따라 설치/다운로드하지 않았다.

실시간: 기존 BrowserSpeechASRAdapter를 ONLINE PREVIEW 입력으로 실제 연결했다. 브라우저가 제공하는 서비스이므로 모델 이름/버전·성능을 앱에서 통제할 수 없다. 모델 설치 없이 마이크 → interim → canonical cue 시연이 가능하지만 인터넷/한국어 지원 브라우저·마이크 권한이 필요하다.

외부 리허설: Soniox `stt-async-v5`를 선택하고 파일 upload/job/poll/transcript/delete 실제 REST 계약을 구현했다. 현재 모델과 한국어 지원, 토큰 시각·신뢰도가 이 작업에 적합한 근거다. [모델 문서](https://soniox.com/docs/stt/models), [시각](https://soniox.com/docs/stt/concepts/timestamps), [신뢰도](https://soniox.com/docs/stt/concepts/confidence-scores).

ElevenLabs Scribe v2, OpenAI transcription, Deepgram 언어/모델도 공식 자료로 검토했다. 한국어 뮤지컬 ground truth를 이용한 공정 비교는 없으므로 Soniox가 절대 최고라고 주장하지 않는다. 비동기 정렬용 선택이며 Soniox realtime 마이크 adapter를 구현했다고 주장하지 않는다.

SONIOX_API_KEY가 서버 환경에 없고 원본 외부 전송 동의도 아직 없다. 실제 외부 ASR 호출 0회. 계정·결제·키를 대신 생성하지 않았다.

## 7. 실제 리허설 observation 상태

**NOT GENERATED**. 실제 원본의 ASR 텍스트/단어 시각/큐 관측값을 생성하지 않았다. 합성 테스트 텍스트를 실제 분석물로 저장하지 않았다.

로컬 검사 실행: `.stage-data/number-analysis/run-d42b18d8-0480-447a-b386-49f31113a6d7/` — inspection/status/run, LOCAL ASR UNAVAILABLE.

외부 동의 차단 실행: `.stage-data/number-analysis/run-fb83d2bb-04be-4545-ba65-f55430361539/` — 동일 원본 검사 성공 후 CLOUD UPLOAD NOT AUTHORIZED, exit 2. 네트워크 업로드 없이 inspection/status/run만 생성했다.

외부 성공 결과는 cloud-asr-pseudo, 로컬 결과는 local-asr-pseudo로 분리한다. 토큰의 원래 시각·신뢰도를 보존하고 한국어 subword를 먼저 어절로 합친다. 겹치는 단어 시각은 조작하지 않고 span-only로 낮춰 검토 대상으로 둔다.

## 8. Matcher 변경

LIVE의 기존 보수적 기준을 무작정 2음절로 낮추지 않았다. 2음절 빠른 경로는 합성 demo에 남긴다. M05-2는 구별 가능한 prefix/internal 증거, 순서, confidence를 사용하며 final을 기다리지 않는다. 정상 next-only, 넓은 검색은 RESYNC다.

이번 개선은 알려진 넘버의 Smith–Waterman 후보 + sequence beam 정렬, 같은 ASR span 안 여러 큐/반복 occurrence, skip/restart, 보정 앵커의 관측 근거·충돌 진단이다. 기존 실제 엔진을 두 번 replay하여 무프로필 baseline과 candidate를 비교한다. 비교용으로 다른 가짜 matcher를 만들지 않았다.

## 9. 반복 가사

A C001–004와 C C018–021에 같은 네 줄이 있다. repeatGroup/occurrence와 경쟁 cue IDs를 기록한다. 네 줄만 있거나 경로가 비슷하면 임의로 A/C를 확정하지 않고 review-required다. 뒤의 고유 가사·앞뒤 순서 증거가 충분할 때만 해당 occurrence로 정렬한다. 먼 반복 앵커는 unique anchor로 표시하지 않는다. 실제 녹음에서 반복 구간 정답은 아직 확인하지 않았다.

## 10. UNMATCHED_SPEECH

무관한 발화는 현재 확정 자막을 유지하고 입력란에만 보인다. 애드리브로 단정하거나 관객에게 STT 문장을 보내지 않는다. Offline 미매칭 span은 UNMATCHED 검토 항목이다. 하나의 부분 매칭 span 안 남은 모든 잔여 조각을 독립 review item으로 추출하는 기능은 아직 완전하지 않다.

## 11. Fallback

기본 OFF. 한 녹음으로 활성화하지 않는다. 3회 이상 독립 표본, 안정된 상대 타이밍, 충분한 confidence, 신규 발화/ASR, 운영자의 큐별 허용 등이 필요하다. 반복 앵커만으로 fallback 허용하지 않는다. 침묵/새 onset만으로 송출하지 않으며 HOLD/RESYNC/IMAGE/불명 포인터/연속 fallback은 차단한다.

## 12. 수동 조작 안전

NEXT/PREVIOUS/JUMP/HOLD/RESYNC는 엔진 checkpoint로 기존 증거를 소비·폐기한다. 로컬 WS는 reset generation/ACK 전후 경계로 늦은 결과를 막는다. 온라인 시연은 이전 인식기를 먼저 무효화·abort하고 새 epoch 인식기를 생성한다. GO/ARM 전 인식은 송출 근거로 재사용하지 않는다. 수동 큐를 보낸 직후 이전 인식기의 final이 도착해도 이중 전환하지 않는 브라우저 회귀를 통과했다. JUMP는 엔진 API이며 별도 UI 버튼은 없다.

## 13. Cue Profile 구조

status=candidate, cueId, sampleCount, confidence, anchors(text/reliability/repetitionRisk/competingCueIds), timing(medianAfterPreviousMs/earlyToleranceMs/lateToleranceMs/varianceMs2/sampleCount/distributionReady), thresholds, fallback. 한 파일의 여러 반복을 여러 독립 리허설로 세지 않는다.

sampleCount=1은 timing distribution 미검증이며 fallback OFF다. 단어 시각 없는 보간은 타이밍 학습에서 제외한다. show+number scope로 이력·analysis hashes·candidate·Champion을 격리하고 canonical fingerprint가 달라지면 재분석한다. 실제 오디오 후보 파일은 아직 없다.

## 14. 생성한 지표

실제 M05-2 정확도, miss/wrong/early/late, 음향→자막 P50/P95, 반복 혼동률, 실제 candidate 개선 수치: **NOT MEASURED**.

비교기는 baseline/candidate 같은 엔진 replay, spoken/sung/solo/duet/chorus 분리, 자동/수동/fallback, 반복 occurrence 혼동, latency/recovery 등을 출력할 수 있다. ASR word 끝 시각을 입력 도착으로 재생한 수치는 simulated-asr-delivery이며 실제 모델 대기 시간·HDMI 표시 지연이 아니다. 현재 이 기능은 합성 timestamp fixture로 검증했다.

## 15. Operator / Audience

Operator는 현재 cue/confidence/미리보기 latency, membrane, 별도 canonical 무대 자막, 다음 큐·Complete, 마이크 원문·파형, 입력 선택·ARM/GO·수동 제어를 제공한다. Audience는 별도 창의 확정 줄/로컬 이미지/검은 화면만 받는다.

단일 Web Lock 운영권, session/epoch/sequence 순서, BroadcastChannel snapshot/ACK/heartbeat를 유지한다. 관객 단절 시 출력은 유지하고 자동 매칭은 대기한다. 중복 운영 창은 포인터를 제어할 수 없다. 물리 HDMI 측정이나 다른 컴퓨터의 출력 동기화는 미구현이다.

## 16. 로컬·오프라인·프라이버시

LOCAL 입력을 명시적으로 선택하고 의존성·모델·에셋을 준비하면 핵심 송출 경로는 loopback과 로컬 자원만 사용한다. 현재 기본 ONLINE PREVIEW와 Soniox 분석은 오프라인 보장 대상이 아니다. 설치형 데스크톱 앱은 아니다.

Soniox 미국 API에 오디오 전체를 전송하기 전 명시적 동의가 필요하다. canonical은 외부 ASR 서비스에 보내지 않고 API 키는 브라우저로 전달하지 않는다. 결과를 받은 뒤 이 실행의 remote job/file만 삭제 요청하고 실패를 감사 파일·UI 경고에 남긴다. 비동기 자료는 삭제하지 못하면 최대 30일 보관될 수 있으며 강제 종료/응답 유실 시 원격 객체가 남을 수 있다. zero-retention 보장은 아니다. [Soniox 정책](https://soniox.com/docs/security-and-privacy).

원본 recordings/, .stage-data/, .env*를 Git 제외한다. FileReplaySource 인터페이스/재생 테스트는 있지만 upload와 live를 하나의 audio→ASR 실행기로 통합하지는 않았다.

## 17. 실행한 테스트와 결과

| 검사 | 결과 |
| --- | --- |
| npm test | 126 passed / 13 files |
| npm run test:backend | 35 passed, 1 skipped — 실제 로컬 모델 사전 준비 필요 |
| npm run typecheck | 통과 |
| npm run build | 통과 — Operator/Rehearsal 동적 서버 페이지 |
| npm run test:e2e | 27 passed |
| git diff --check | 통과 |
| 실제 WAV full decode/hash | 성공, 전후 동일 |
| 실제 외부 ASR | 실행 안 함 — 키·전송 동의 없음 |

27개 E2E에는 36개 M05-2를 final/수동 NEXT 없이 순서대로 표시, ARM 이전 송출 차단, 입력/확정 자막 분리, manual 직후 old final 차단, cloud 동의 gating, 기존 16개 demo, OVERLAP, local reset ACK, audience 권한/재접속, 리허설 검토·승격 차단이 포함된다. **ASR 이벤트는 합성이며 실제 음향 성능 증명이 아니다.**

Backend HTTP 계약 검사는 mock transport로 수행하며 외부에 오디오를 보내지 않는다. registry 확장 테스트는 임시 TEST ONLY 대본이며 실제 미래 넘버가 아니다. 이 테스트에서 macOS /var 심볼릭 링크 경로 비교 버그를 찾아 수정했다. Next/React 지침에 따른 상태 격리와 기존 사용자 대본 보존도 확인했다. 화면은 agent-browser/Playwright로 확인했으며 in-app browser bootstrap은 환경 오류로 사용할 수 없어 대체했다.

## 18. 아직 실공연 준비가 되지 않은 항목

실제 한국어 가창/반주/중첩 ASR와 큐별 사람이 확인한 정답, 외부 서비스 실호출, 최소 3개 독립 리허설/hold-out, 실제 baseline 대 candidate 비교, 실측 음향/프로젝터 지연, 장시간 안정성, 장치 교체, 공연장 리허설이 남았다. Soniox batch를 live streaming으로 연결하지 않았다. 현재 선택이 다른 최신 모델보다 이 공연에 더 좋다는 비교 근거도 아직 없다. 단일 입력·단일 포인터이며 가수별 독립 병렬 정렬은 없다.

## 19. 바로 다음 단계와 정확한 실행 방법

지금은 로컬 모델 없이 `/operator` → 기존 브라우저 모델 → 관객 화면 열기 → ARM → 마이크 ON → GO로 시연할 수 있다. 한국어 지원 Chrome과 인터넷을 사용한다.

실제 녹음 분석은 **Soniox 미국 전송에 대한 사용자 동의와 서버 SONIOX_API_KEY 설정** 후 다음 명령 한 번으로 수행한다. 키는 채팅에 붙이지 말고 서버를 실행하는 로컬 셸 환경변수에 설정한다.

```bash
npm run rehearsal:analyze -- --number M05-2 --provider soniox --allow-cloud-upload
```

원본은 registry의 실제 경로에서 읽는다. 대체 파일은 `--audio "상대/경로.wav"`를 지정한다. 모델/전송 없이 검사를 재현하려면:

```bash
npm run rehearsal:analyze -- --number M05-2 --inspect-only
```

실제 observation을 얻으면 먼저 A/C 반복 및 B 대사 전환 시각을 사람이 듣고 확인하고 baseline/candidate 차이를 검토한다. 이 한 녹음으로 Champion을 승격하지 않는다. 자세한 사용법은 [README](../README.md), 설계는 [architecture](architecture.md), 변경 전 조사·계획은 [work log](m05-2-work-log.md)에 있다.
