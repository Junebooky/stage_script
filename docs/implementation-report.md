# 구현 보고서 — implemention_plan.md / ref_new.tsx

검증일: 2026-09-12. 기존 데모를 유지하면서 로컬 공연 runtime, 관객 출력, 리허설 보정 경로를 구현했습니다. **실제 공연 승인 완료 또는 실측 저지연 보장 상태는 아닙니다.**

## 1. 기존 architecture의 핵심 문제

단일 flat demo 포인터, 브라우저 ASR, transport mock을 중심으로 구성되어 있었습니다. 확정 자막/인식 원문 분리는 있었지만 막 경계, readiness, 별도 관객 출력, 보수적인 공연 정책, 리허설 분석/프로필 승인 경로가 없었습니다. 2음절 fast path는 시연에는 적합하지만 반복 가사에서 실공연 오송출 위험이 있습니다. 최종 문장 확정 지연과 UI 처리 지연도 구분해야 했습니다.

## 2. 실제 변경한 architecture

DEMO와 PERFORMANCE_LOCAL을 분리했습니다. Show → Act → Number → Cue 계층, 활성 막 전용 ScriptFollowingEngine과 ShowRuntime, 단일 authoritative Operator, read-only Audience, 별도 rehearsal Observation/Profile 저장을 추가했습니다. UI는 `/demo`, `/operator`, `/output`, `/rehearsal`입니다. 3D는 `ref_new.tsx`의 membrane dot field로 교체했고 자막·파형·마이크 원문·다음 큐를 유지했습니다.

## 3. 주요 파일

| 역할 | 주요 파일 |
| --- | --- |
| Canonical / profile 검증 | `packages/script-schema/src/index.ts`, `assets.ts` |
| Matcher / evidence cursor | `packages/alignment/src/index.ts`, `packages/script-engine/src/hypothesis-cursor.ts` |
| Cue / Act runtime | `packages/script-engine/src/index.ts`, `show-runtime.ts` |
| Operator / local mic | `apps/web/components/OperatorExperience.tsx`, `hooks/use-performance-session.ts`, `hooks/use-microphone.ts` |
| Audience 동기화 | `components/AudienceOutput.tsx`, `hooks/use-audience-publisher.ts`, `lib/audience-protocol.ts` |
| Rehearsal | `packages/rehearsal/src/`, `components/RehearsalWorkspace.tsx` |
| ASR / 파일 작업 / 저장 | `services/audio-engine/app/adapters/local.py`, `main.py`, `sources.py`, `rehearsal.py` |
| 3D | `apps/web/components/HologramAvatar.tsx`, `lib/membrane-shaders.ts`, `components/membrane.css` |
| 회귀 | `packages/**/src/*.test.ts`, `services/audio-engine/tests/`, `tests/e2e/` |

사용자 원본 `ref_new.tsx`, 구현 계획, 대본 PDF와 기존 canonical demo 문장은 수정하지 않았습니다. React 점검 기준에 따라 effect 정리, 단일 runtime 초기화, 오래된 비동기 결과 폐기, 읽기 전용 화면 분리를 검토했습니다.

## 4. Matcher 변경

기존 ordered 2음절 interim 경로는 DEMO에 유지합니다. 공연은 prefix/internal anchor/local fuzzy/sequence/ASR/speech/timing component를 사용합니다. 인접 동일·유사 가사의 증거 품질을 비교해 이전 가사 반복이 다음 큐로 오인되는 경우를 막습니다. 시작 가사를 놓쳐도 내부의 고유 증거로 회복합니다. Cursor는 전체 문장 완성 대신 실제 소비한 증거 범위만 추적합니다. 점수는 설명 가능한 heuristic이지 보정된 정확도 확률은 아닙니다.

## 5. Fallback / UNMATCHED

충분한 미일치 발화는 UNMATCHED_SPEECH이며 기존 자막을 유지합니다. 애드리브 판정이나 원문 송출을 하지 않습니다. Fallback 기본 OFF, 큐별 명시 허용, 3회 이상 안정된 표본, 강한 직전 동기화, 새 VAD onset, 상대 window, 신규 ASR evidence를 모두 요구합니다. 새 onset만 조건을 만족하면 FALLBACK_READY를 표시하되 송출하지 않습니다. timer-only, unknown pointer, IMAGE, HOLD, RESYNC, fallback chain은 차단합니다.

## 6. Manual override safety

수동 NEXT/PREVIOUS/JUMP는 즉시 적용합니다. 기존 evidence와 보류 hypothesis를 폐기하고 로컬 ASR reset generation을 올립니다. ACK 이후 새 세대 결과만 자동 처리하여 조작 전 PCM에서 늦게 나온 결과가 double-trigger하지 못하게 합니다. 엔진 자체도 수동 시각/checkpoint/새 발화 검사를 합니다. ACK timeout은 자동 인식을 차단하지만 수동 기능은 유지합니다. 합성 WebSocket E2E에서 ACK 전 결과·이전 세대 final을 거부하고 새 interim으로 다음 큐가 송출됨을 확인했습니다.

## 7. Act / Intermission

PRE_SHOW → ACT_ARMED → GO → ACT_LIVE → ACT_COMPLETE → INTERMISSION → 다음 ARM/GO, 마지막 막은 SHOW_COMPLETE입니다. GO는 input/ASR/assets/output readiness를 검사합니다. 명시적인 manual-only는 마이크/ASR만 면제합니다. 인터미션 중 NEXT/음성은 다음 막을 시작하지 않습니다. 막 경계에서 활성 대본/포인터/상대 기준을 격리합니다. 출력은 black/clear/last-caption 중 공연 전에 선택합니다.

## 8. Operator / Audience

Web Lock으로 송출권을 단일화하고 BroadcastChannel의 session/epoch/sequence로 canonical-only snapshot을 전달합니다. Audience에는 engine, 대본 탐색, 버튼, 디버그, ASR가 없습니다. 재연결/새 창은 최신 상태를 받고 끊기면 마지막 출력을 유지합니다. 최신 cue ACK만 준비 상태로 인정하며 오래된 이미지 load도 배제합니다. 로컬 이미지/BLACK, F·더블클릭 전체 화면, HDMI 확장 화면 흐름을 제공합니다. OS 디스플레이 설정은 사용자가 해야 하며 실제 HDMI 장비는 이번에 시험하지 않았습니다.

## 9. Rehearsal analysis

원본 WAV/FLAC/M4A/MP3 업로드 → 로컬 timestamp ASR → 전체 넘버 global alignment → 넘버 안 local alignment → observation/review 저장을 구현했습니다. 넘버/큐 생략, 재시작, 반복 가사, 긴 gap을 다룹니다. 자동 시각은 pseudo이며 word timestamp가 없으면 보간합니다. 사람은 원본 청취 후 시각을 확인하거나 제외 사유를 기록합니다. canonical은 변경하지 않고 이전 분석 revision을 보존합니다. 브라우저 E2E의 acoustic model 응답은 stub이며 이후 정렬·검토·보정은 실제 코드를 실행했습니다.

## 10. Cue Profile

Cue ID, canonical 고유 anchor와 reliability, 직전 cue 대비 중앙 onset/early·late tolerance/variance, text·fallback threshold, 독립 rehearsal sampleCount, confidence, fallback enabled를 생성·검증·적용합니다. 동일 녹음의 반복을 독립 표본으로 늘리지 않습니다. 인접 cue가 아니거나 막이 다르면 상대 timing을 학습하지 않습니다. 실제 공연 기준으로 검증된 프로필이 이미 포함된 것은 아닙니다.

## 11. Champion / Challenger

동일한 보수적 engine으로 모든 완료 녹음을 재생해 기존/후보 프로필을 비교합니다. 최소 3회, review 미해결 없음, 모든 지표 무회귀, 측정 가능한 개선, 운영자 이름/승인이 필요합니다. 서버는 이력 누락, 분석 hash/revision 변경, canonical 변경, 기존 Champion 변경을 검사합니다. 이전 Champion을 보존하고 운영 화면에서 별도로 불러오게 합니다. LIVE 자동 교체는 없습니다. 회귀 수치는 브라우저 계산 결과를 서버가 검사하는 구조이지 서버가 신뢰 실행으로 재계산하는 구조는 아닙니다.

## 12. Local ASR의 현재 수준

선택적 faster-whisper 실제 provider와 async rolling chunk adapter를 구현했습니다. 모델은 로컬 파일만 허용하고 다운로드하지 않습니다. 첫 버퍼 400 ms, 최소 갱신 간격 320 ms, 최대 12초 버퍼/동시 추론 1개입니다. 한국어 지원/모델 파일/토크나이저를 확인합니다. 실시간과 리허설 모델 점유는 상호 배제합니다. 현재 환경에는 모델 경로가 설정되지 않아 실제 준비 응답은 LOCAL ASR UNAVAILABLE입니다. 음소 streaming CTC/transducer도, 실제 모델/가창 검증 완료 상태도 아닙니다.

## 13. Offline의 외부 의존성

PERFORMANCE_LOCAL의 송출에 외부 API·CDN·웹 폰트는 필요하지 않습니다. 사전 설치한 Node/Python 의존성·모델·브라우저·로컬 에셋과 실행 중인 두 서버, OS 오디오/디스플레이 장치가 필요합니다. 동일 origin/profile의 BroadcastChannel/Web Locks 지원 브라우저를 사용해야 합니다. 설치/모델 확보는 별도 준비이고 DEMO의 브라우저 ASR는 네트워크를 사용할 수 있습니다. 데스크톱 패키징/서비스 워커/다중 PC 네트워크 출력은 미구현입니다.

## 14. 검증 결과

| 명령 / 확인 | 결과 |
| --- | --- |
| `npm test` | 105 passed / 11 files |
| `npm run typecheck` | 통과 |
| `npm run build` | 통과, 4개 화면 포함 정적 route 생성 |
| `npm run test:backend` | 18 passed, 실제 모델 통합 1 skipped, 라이브러리 deprecation 경고 2개 |
| `npm run test:e2e` | 24 passed |
| E2E 파일 TypeScript 검사 | Bundler module resolution으로 통과 |
| `git diff --check` | 통과 |
| 실제 브라우저 | 새 membrane, PC/mobile 자막·파형, 운영 화면, 리허설 화면 확인 |
| 실제 `/readiness` | 모델 미설정 → local_ready=false, mock 전환 없음 |

16개 demo는 최종 확정 0회·수동 0회로 전환했습니다. 최종 회귀 실행의 **합성 ASR 주입→paint** 중앙값 20.7 ms / 최대 33.7 ms였으며 실제 음성→자막 성능값이 아닙니다. 실제 로컬 모델 테스트는 `STAGE_TEST_LOCAL_MODEL_DIR`, `STAGE_TEST_KOREAN_AUDIO` 미제공으로 skip했습니다. 실제 마이크 청취·가창·공연장 HDMI 시험은 수행하지 않았습니다.

## 15. Production-ready가 아닌 부분

- 현장 모델/장비의 가창 인식률, wrong/early/miss, 실제 음향→관객 화면 P50/P95/P99와 장시간 부하를 검증하지 않았습니다.
- Calibration과 regression이 같은 이력을 사용합니다. 별도 hold-out/human ground truth가 필요합니다. 자동 정렬은 완벽한 실제 공연 위치 추적이 아닙니다.
- IMAGE 진입은 수동입니다. 이미지 cue의 실제 onset/exit 라벨을 자동 추출하는 UI는 없습니다. 평가 함수는 제공된 image observation을 평가할 수 있습니다.
- AudioSource와 파일 배속 replay는 구현·테스트했지만 LIVE/upload 전체를 같은 실행기로 통합하지 않았습니다. 회귀 UI는 ASR transcript replay이며 GUI audio replay benchmark가 아닙니다.
- 리허설 분석은 브라우저 main thread입니다. 긴 전체 공연의 처리 시간/메모리, 취소·진행률·재분석/재시도 UX는 추가 작업이 필요합니다. 실패 재시도는 API만 있습니다.
- canonical 수정 후 이전 이력을 현재 대본으로 재분석해야 합니다. 이를 일괄 처리하는 GUI는 없습니다.
- Operator 재시작의 LIVE pointer 복원, persistent whole-show telemetry, trace clock 동기화, audience physical paint 측정은 없습니다. 로그는 최근 2000건입니다.
- REST 분석 payload 검증, 신뢰 실행 회귀, crash-safe 장기 작업/백업·보관 정책 등 로컬 공연 도구의 운영 강화가 필요합니다.

## 16. 다음 구현 우선순위

1. 실제 공연 노트북과 한국어 지원 모델/원본 녹음으로 로컬 ASR 통합 테스트를 실행하고 사람 검토한 cue onset을 확보합니다.
2. 가창·반복·긴 솔로·겹침·생략·수동 복구를 포함한 별도 리허설로 오송출과 전체 지연을 측정합니다. 필요하면 streaming CTC/transducer adapter를 비교합니다.
3. 원본 오디오 배속 replay, worker 기반 장시간 정렬, 취소/진행률/재시도/대본 변경 재분석 UI를 통합합니다.
4. 실제 HDMI/프로젝터, 입력 장치 재연결, 관객 창 종료, 로컬 ASR 장애, 막 경계를 현장에서 검증하고 운영자 승인 기준을 확정합니다.
5. persistent log/trace, explicit recovery checkpoint, 서버 측 신뢰 회귀 실행과 보관/백업을 강화합니다.

실행 방법은 [README](../README.md), 상세 상태/데이터 경계는 [architecture](architecture.md), 측정 기준은 [latency](latency.md)를 참고하세요.
