# R001 / M05-2 realtime replay — 구현·검증 보고

2026-09-14. `ref_v2.md` 범위: 원본 오디오 + 이미 저장된 실제 ASR로 기존 공연 자막 엔진을 검증하는 로컬 리플레이. 새로운 전사, 모델 설치, 일반 공연 제어 시스템은 구현하지 않았다.

## 1–4. 기준 커밋과 변경 파일

시작 HEAD와 종료 HEAD는 모두 `202f43124e9140a6e06a819be05de21f7114f3a5` (`main`)이다. 시작 작업 트리는 깨끗했다. 이번 변경은 커밋하지 않은 작업 트리에 있으며 push하지 않았다.

추가 파일 15개:

- `apps/web/components/RecordingReplay.tsx`
- `apps/web/hooks/use-recording-replay.ts`
- `data/replay-recordings/registry.json`
- `data/replay-recordings/R001-M05-2.profile.json`
- `data/replay-recordings/R001-M05-2.reference.json`
- `packages/rehearsal/src/recording-profile.ts`
- `packages/rehearsal/src/realtime-replay.ts`
- `packages/rehearsal/src/recording-evaluation.ts`
- `packages/rehearsal/src/recording-replay.test.ts`
- `services/audio-engine/app/registered_replay.py`
- `services/audio-engine/tests/test_registered_replay.py`
- `scripts/replay-recording.mjs`
- `scripts/verify-replay-browser.mjs`
- `tests/e2e/recording-replay.spec.ts`
- `docs/recording-replay-v2-report.md`

기존 파일 수정 5개:

- `apps/web/components/RehearsalWorkspace.tsx`: 독립적인 04 리플레이 패널 연결. 기존 업로드/정렬/승격 로직 그대로.
- `apps/web/app/globals.css`: 리플레이 전용 스타일.
- `packages/rehearsal/src/index.ts`: 새 도메인 모듈 export.
- `services/audio-engine/app/main.py`: 읽기 전용 등록 리플레이 라우터 연결.
- `package.json`: 저장 증거 검사와 실제 브라우저 검증 명령 추가.

개발 서버가 일시 변경한 `next-env.d.ts`는 최종 build로 원래 내용으로 돌아왔다. `.stage-data`, 원본 녹음, 키, `ref_v2.md`는 기존 ignore 규칙을 유지한다.

## 5–8. 녹음 프로필·투영·공연 정책

`RecordingReplayProfile`은 rehearsal 도메인의 버전 1 타입이다. `recordingId`, `showId`, `numberId`, `canonicalFingerprint`, 원본 상대 경로/SHA-256, `performedCueIds`, `absentCueIds`, 생략 확인 근거, 저장 ASR 출처(run/provider/model/path/hash/confidence 상태), `nonCanonicalEvents`를 구분한다. 평가 시각은 이 프로필이나 런타임 엔진 안에 넣지 않았다.

`buildRecordingReplayScript(show, profile)`은 순수 복사/필터 함수다. 해당 넘버의 원래 cue 배열 순서대로 27개만 복사한다. ID·order·caption·matcher 메타데이터를 유지하며 배열 순번이나 텍스트를 다시 작성하지 않는다. C008의 다음 투영 큐는 C018이다. 입력의 ID 중복, 양쪽 집합 겹침, 알 수 없는 ID, 누락, 다른 show/number/fingerprint, 잘못된 출처는 거부한다.

원본 canonical은 **36개 그대로**, fingerprint는 `0d6009c3`이다. 파일 SHA-256은 다음과 같다.

```text
823e4630702aa3c1be4b2b59fed7fd10507ae3c0a459dcf8bb098407bfe73e74
```

`packages/script-engine`, `packages/alignment`, `packages/script-schema`, `data/productions`, 기존 `packages/rehearsal/src/replay.ts`의 diff는 없다. 새 컨트롤러도 **같은 `ScriptFollowingEngine` / `PERFORMANCE_LOCAL`**을 사용한다. next-only 후보 정책, 임계값, 자동 복구 정책을 바꾸지 않았다. 원본 36개를 넣은 엔진이 C008 이후 C009를 계속 기다리는 회귀 테스트도 통과했다.

투영은 canonical의 내장 메타데이터를 보존한다. 다만 리플레이 컨트롤러는 내장 Cue Profile이 있는 입력을 거부하여 calibration/fallback이 우회 적용되지 않게 한다. R001 canonical에는 내장 프로필이 없다. 새 Cue Profile 생성·sampleCount 증가·Champion 승격은 하지 않았다.

## 9. 로컬 데이터·오디오 API

두 GET 경로만 추가했다.

```text
GET /replay-recordings/R001-M05-2
GET /replay-recordings/R001-M05-2/audio
```

브라우저는 등록 ID만 보낸다. query/path 입력을 받지 않는다. 서버는 신뢰된 registry로 파일을 찾아 canonical/audio/ASR 해시, 프로필 집합, 원본 오프셋 0과 전사 출처를 검사한다. 경로 정규화 후 approved root 밖으로 나가는 경로·symlink, 변경된 해시, 파일 부재를 거부한다. loopback 클라이언트·호스트와 기존 local-origin 정책을 함께 적용한다.

원본 WAV를 `FileResponse`로 직접 제공하며 Range(206)를 지원한다. 업로드용 `.stage-data/rehearsals`로 복제하지 않는다. 등록된 CLI 분석 저장소를 별도로 읽는다. 원본 오디오를 변환·이동·개명·덮어쓰지 않는다.

응답은 필요한 단어/텍스트/출처만 whitelist한다. 원본 provider audit, request metadata, tokens, `x_groq`, Authorization, API key는 반환하지 않는다. 새 모듈에는 ASR provider 호출이나 쓰기 코드가 없다. 원본/증거가 없거나 검증에 실패하면 명시적으로 중단하고, 전사·재업로드·다른 공급자로 fallback하지 않는다.

## 10–12. 오디오 시계·증거 전달·수명주기

유일한 시계는 실제 `HTMLAudioElement.currentTime`이다. 단어 `endMs <= currentTime * 1000`일 때만 cumulative partial을 만들고 엔진의 `processHypothesis()`에 전달한다. trigger의 시각은 실제로 처리한 오디오 시각이며 원래 단어 종료 시각도 로그에 별도 보존한다. 기준 시각으로 자막을 dispatch하는 경로는 없다.

원본 provider의 24개 segment, 129개 word를 모두 사용한다. 일부 provider segment 경계가 자기 단어와 겹치거나 어긋나므로, **원본 segment 텍스트와 연속된 원본 word 텍스트의 일치만으로** 그룹화한다. canonical, reference, 기존 alignment observation은 이 그룹화 입력이 아니다. 단어 타임스탬프는 바꾸지 않고, speech envelope만 소속 단어의 min/max로 정의한다. 원본 segment 경계와 경고도 출처로 유지한다. native word confidence는 전부 `null` / `unavailable`이며 가짜 확률을 만들지 않았다.

첫 브라우저 실행에서 RAF만 사용하면 관객 창에 포커스를 옮길 때 운영 창의 RAF가 멈추어 증거가 뒤늦게 묶이는 문제를 발견했다. 최종 hook은 40ms polling과 오디오 `timeupdate` 이벤트를 함께 사용한다. 둘 다 현재 오디오 시각을 읽을 뿐, 타이머 tick 수나 wall clock으로 재생 위치를 계산하지 않는다. 중복 호출은 evidence cursor가 막는다.

- START: 새 엔진, 0초, cursor 0, 새 run identity, fallback OFF.
- PAUSE: 실제 audio.pause와 입력 전달 중지.
- RESUME: 같은 엔진·utterance identity·cursor로 계속 진행. 이미 처리한 단어를 다시 넣지 않는다.
- STOP: 오디오 중지, 콜백 generation 무효화, 관객 출력 black. 부분 평가 이력은 보존한다.
- RESTART: 새 엔진·새 로그·새 cursor·0초. 과거 play promise나 콜백으로 이전 run이 살아나지 않는다.
- 탐색/배속: 임의 seek와 1.0× 이외 속도를 차단하고 RESTART를 요구한다.
- 수동 NEXT/PREV/HOLD: 명시적 버튼으로만 실행. 수동 전환 이전에 들은 증거와 현재 cumulative utterance의 잔여분을 checkpoint/retire한다. 자동 manualNext/jump/resync는 없다.

출력은 기존 `useAudiencePublisher`의 단일 Web Lock, BroadcastChannel, epoch/sequence/ACK 경로를 그대로 사용한다. 다른 운영 창이 권한을 갖고 있으면 START를 차단한다. audience에는 canonical caption/image만 전송하며 ASR·기준 시각·생략 정보는 운영 패널에만 보인다.

## 13. 별도 RecordingReference

버전, recording ID, canonical fingerprint, `quality: silver-reference`, `basis: asr-assisted-reference`, 출처, 27개 `{cueId, referenceStartMs, warnings?, repeatGroup?, occurrence?}`, 9개 absent ID를 별도 JSON으로 저장한다. 기존 `alignment.json`의 observation을 정답으로 승격하지 않았다.

C007의 것/건, C008의 돌아와요/더러워요, C024의 궂은/굳은, C027의 건네드릴/던져드릴, C035 왜곡, C036의 별이여/별이야 경고를 그대로 보존한다. 이는 human-confirmed/gold 데이터가 아니다.

## 14. 27개 평가 결과

최종 실제 브라우저 검증: 원본 **226.138479초**, 실제 경과 **226.592초**, 1.0×. 관객 DOM에 **27개 모두 원래 순서/원문으로 렌더링**됐음을 별도로 확인했다. 최종 full run에는 수동 cue 개입이 없다. 25–85초에는 관객 창을 앞으로 가져와 백그라운드 운영 창도 검증했다.

| 지표 | 결정적 저장 증거 검사 | 실제 경과 브라우저 검사 |
| --- | ---: | ---: |
| performed / correct | 27 / 27 | 27 / 27 |
| missed / wrong | 0 / 0 | 0 / 0 |
| early / late | 0 / 27 | 0 / 27 |
| median absolute timing error | 3120.25ms | 3146.952ms |
| P95 absolute timing error | 3934ms | 3970.050ms |
| recording absent | 9 | 9 |
| unexpected skip / repeated confusion | 0 / 0 | 0 / 0 |
| post-take false trigger | 0 | 0 |
| primary / cascade failure | 0 / 0 | 0 / 0 |
| manual / fallback trigger | 0 / 0 | 0 / 0 |
| max evidence delivery lag after word end | 0ms (simulation) | 36.664ms |

`correct`는 올바른 cue identity라는 뜻이지 정시 송출이라는 뜻이 아니다. 전부 기존 평가 허용치보다 늦었다. early는 −250ms 미만, late는 +1500ms 초과이며 기존 `evaluateTriggers` 기본값을 그대로 사용했다. 성공처럼 보이도록 허용치를 바꾸지 않았다. 이 수치는 **저장 ASR 재생 timing error이지 실시간 ASR inference/network latency가 아니다.**

아래는 실제 브라우저 run의 cue별 결과다. trigger와 signed error는 ms 반올림이며 원래 정밀값·source·flags는 JSON에 있다. 모든 source는 automatic, category는 LATE다.

| Cue | Reference ms | Trigger ms | Signed error ms |
| --- | ---: | ---: | ---: |
| C001 | 8420 | 11777 | +3357 |
| C002 | 16400 | 18896 | +2496 |
| C003 | 24000 | 27976 | +3976 |
| C004 | 32420 | 34896 | +2476 |
| C005 | 40420 | 44376 | +3956 |
| C006 | 48700 | 50576 | +1876 |
| C007 | 56060 | 59691 | +3631 |
| C008 | 61620 | 67016 | +5396 |
| C018 | 78800 | 81657 | +2857 |
| C019 | 85040 | 88096 | +3056 |
| C020 | 92380 | 96296 | +3916 |
| C021 | 99860 | 102376 | +2516 |
| C022 | 108880 | 111097 | +2217 |
| C023 | 115229 | 118376 | +3147 |
| C024 | 123109 | 125415 | +2306 |
| C025 | 130409 | 132136 | +1727 |
| C026 | 137989 | 141056 | +3067 |
| C027 | 141029 | 144296 | +3267 |
| C028 | 152049 | 155216 | +3167 |
| C029 | 155189 | 159034 | +3845 |
| C030 | 166369 | 169337 | +2968 |
| C031 | 173989 | 176034 | +2045 |
| C032 | 179209 | 181777 | +2568 |
| C033 | 190369 | 193576 | +3207 |
| C034 | 195529 | 199137 | +3608 |
| C035 | 199109 | 202257 | +3148 |
| C036 | 210729 | 213976 | +3247 |

## 15–18. 반복·생략·종료 후 발화·연쇄 실패

C001–C004는 첫 occurrence, C018–C021는 두 번째 occurrence로 각각 송출됐다. audience에서도 각 ID를 따로 확인했다. C008 이후는 투영에서 C018이 next이므로 원본 B 대사 C009–C017를 뛰어넘는 엔진 정책은 필요하지 않다. absent 9개는 miss가 아니며 어느 관객 frame에도 나오지 않았다.

223709–224409ms의 “감사합니다.”는 저장 증거로 엔진에 전달하고 운영 진단에서 `POST_TAKE_SPEECH`으로 표시한다. canonical C016으로 강제 정렬하지 않는다. 최종 관객은 C036 원문을 유지했고 C016/되감기/재시작/자동 resync는 0회였다.

이번 실제 run의 primary/cascade failure는 모두 0이다. 별도 회귀 사례에서는 C024의 직접 실패와 C025 이후의 `CASCADE_BLOCKED`를 구분하며 `blockedByCueId`를 기록한다. 수동 회복 후에는 새로운 실패 묶음을 시작한다. 진행 중 화면의 miss/blocked 분류는 잠정값으로, 늦은 실제 trigger가 나오면 갱신된다. 완주하지 않은 STOP 결과는 `complete: false`다.

## 19–25. 검증과 원본 무결성

| 검증 | 결과 |
| --- | --- |
| `npm test` | 165 passed, 14 files (신규 35개 포함) |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm run test:backend` | 78 passed, 1 skipped — 기존 선택적 local-model 검사 |
| `npm run test:e2e` | 32 passed (신규 합성 브라우저 4개 포함) |
| `git diff --check` | passed |
| 실제 전체 오디오 브라우저 검증 | passed, 226.592s 경과, 27개 관객 DOM 렌더 |

초기 agent-browser 화면 확인과 직접 transport 조작 후, 재현 가능한 별도 Chromium full-run 검증도 수행했다. 최종 full-run은 headless Chromium에서 실제 WAV를 디코딩/재생한 것이다. 물리 스피커 청취나 human timing confirmation은 주장하지 않는다. 모든 페이지 요청은 localhost GET만 허용했고 외부 요청과 mutation을 차단했으며 브라우저 오류는 0개였다. Pause에서 시계/지표 정지, Resume 진행, Stop black, Restart 0초를 검사했다. E2E에서는 수동 checkpoint와 송출 권한 충돌도 확인했다.

최종 전체 재생 후 원본 WAV SHA-256:

```text
2b7ce5887f92a5527f4dca1564d00aa2c95eb834ca2e0d6d06189b4588cdb5e7
```

작업 전후 동일하다. 기존 ASR와 alignment 파일도 변경되지 않았다.

```text
external-asr.json  df3d8128e169e87775653955c3f6405744964af40dbc04b70edbd614ba30d5cf
alignment.json     fe34798d4a401440f65f96a7cae5d6e374ac07073697a99c1dd4db8be790d722
```

로컬 비공개 검증 artifact:

```text
.stage-data/replay-evaluations/browser-8d82919c-8b5f-4055-8dec-4f20a78e22b9/
  evaluation.json
  browser-validation.json
  operator-complete.png
  audience-repeated-opening.png
  audience-complete.png

.stage-data/replay-evaluations/check-57b88b42-e10f-4f03-b5a4-9bfc2ba0791f/
  evaluation.json
```

JSON에는 cue별 평가, 실제 trigger/delivery 로그, source hashes가 있다. browser-validation에는 원본 해시 전후, 실제 경과 시간, 1.0× 오디오 상태, 관객 DOM에 렌더된 ID/원문, lifecycle 결과와 로컬 요청 목록이 있다. 키나 Authorization header는 포함하지 않는다. artifact/오디오/사용자 reference 원문은 Git에 추가하지 않았다.

## 26–27. 사용법·한계·시연 판정

로컬 백엔드와 웹 서버를 실행하고 `/rehearsal` → **R001 리플레이 준비** → **START REPLAY**를 누른다. **관객 송출 ↗**로 별도 출력을 연다. 준비 시 SHA 검증을 하며, 키·새 전사·오디오 업로드는 필요 없다. 다른 운영 창이 락을 갖고 있으면 먼저 그 창을 닫는다.

```sh
npm run dev:backend
npm run dev

# 빠른 결정적 검사: 실제 elapsed playback 아님
npm run rehearsal:replay-check

# 두 서버가 실행 중일 때: 실제 원본으로 약 4분, 외부 요청 차단
npm run rehearsal:verify-browser
# 선택: 실제 표시되는 Chromium 창으로 검증
REPLAY_HEADED=1 npm run rehearsal:verify-browser
```

27개 canonical의 순차 송출/반복 구분/원본 재생 메커니즘을 보여주는 데모는 동작한다. 하지만 **즉시 반응하는 저지연 공연 시연으로는 아직 준비되지 않았다.** 단어 끝까지 기다리는 저장 ASR 증거와 보수적 matcher 때문에 전체 27개가 늦었고, C008은 약 5.4초 늦었다. UI polling 지연은 최대 36.7ms로 이 문제와 구분된다. 모델·임계값·송출 시각을 임의 조정해 이를 감추지 않았다.

R001의 B 대사 생략은 이 녹음만의 확인 정보다. 다른 녹음·중간부터 시작·반복 재시작·일반 생략·임의 seek의 안전성을 증명하지 않는다. 완전한 브라우저/OS suspension에서도 지속 실행을 보장하지 않는다. 여러 녹음 및 사람의 청취 검토가 필요하며 **production readiness와 실제 live ASR latency를 주장하지 않는다.**

추가로 0.2초 간격 합성 큐 테스트에서 한 큐가 다른 큐와 같은 poll/paint에 합쳐진 경우를 관찰했다. 최종 일반 UI 배선 fixture는 cue별 0.5초 표시 구간을 두며, stall로 생기는 동일-poll trigger는 별도 회귀 테스트와 `coalescedAutomaticTriggerCount`/화면 경고로 드러낸다. 중간 큐를 실제로 그렸다는 근거 없이 `correctTriggerCount`를 audience 렌더 수로 해석하지 않는다. 실제 R001 full-run의 관객 DOM 27개는 별도로 검증한 결과다. 이 진단 추가는 evaluation/UI 변경이며 원본 timestamp나 matcher 임계값 조정이 아니다.

Next.js/React 점검 지침에 따라 클라이언트 제어·순수 도메인·로컬 파일 API를 분리했다. 실제 브라우저 검증 지침에 따라 화면뿐 아니라 파일→증거→엔진→관객 DOM까지 확인했고, 그 과정에서 발견한 백그라운드 RAF 중단 문제를 수정했다.
