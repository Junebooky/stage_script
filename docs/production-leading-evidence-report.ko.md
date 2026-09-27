# 프로덕션 선두 토큰 Early Evidence 최적화 결과

검증일: 2026-09-27

## 1. 적용 범위와 단일 런타임

실제 `ShowRuntime → ScriptFollowingEngine → DiscriminativeWordMatcher` 경로를 변경했다. `ScriptFollowingEngine`의 기본 matcher를 `DiscriminativeWordMatcher`로 연결하여, 별도 플래그 없이 PERFORMANCE_LOCAL에서 실시간 interim 선두 접두사를 평가한다. 브라우저와 로컬 ASR 모두 동일 엔진을 사용한다.

새 시연 전용 엔진, provider, reference trigger, 타이머 기반 큐 송출, 특정 큐 ID/가사 예외는 추가하지 않았다. 기존 음원 타임라인 시연 UI는 이번 최적화의 근거로 사용하지 않았으며, 회귀 요구에 따라 동작을 유지했다. 기존 saved-completed-words 입력의 내부 두 단어 복구는 기존 provenance 조건을 유지한다. 새 **선두 접두사 정책은 live와 saved 입력에 공통**으로 적용된다.

## 2. 선두 변별 토큰과 위치 가중치

새 조기 증거는 다음 조건을 모두 충족해야 한다.

- PERFORMANCE_LOCAL / NORMAL / 바로 다음 큐(candidateOffset=0), 실제 speechActive.
- IMAGE가 아니며 canonical 정규화 길이가 4 이상. 원래 2~3글자로 작성된 짧은 큐의 confidence 보호는 유지한다.
- canonical 첫 어절의 접두사와 관측 어절 전체가 정확히 일치하고, 관측은 정규화된 한글 2음절 이상이다. 관측 어절을 잘라 억지로 일치시키지 않는다.
- 관측 어절 시작은 소비된 커서 이후의 실제 어절 경계여야 한다.
- 기능어/대명사/접속사 목록에 해당하는 시작은 조기 증거로 쓰지 않고 후속 증거를 기다린다. 예: 우리, 그리고, 하지만, 그렇지만, 그러므로.
- 인접 큐(기존 앞뒤 최대 3개)의 모든 정규화 문자열 조각과 비교한 최대 편집 유사도를 C라 하면, `margin = 1 − C ≥ 1/3`이어야 한다. 이전 큐 꼬리, 공유 접두사, 인접 반복 가사도 경쟁 증거로 간주한다.

위치 가중치 `P`는 고유한 선두 증거에서 **1.5**, 기존 일반 anchor 점수에서는 **1.0**이다. 정확 일치·순서·발화 조건을 통과한 선두 증거 점수는 다음과 같다.

```text
K = 0.50 × text(1) + 0.15 × anchor(1) × P
  + 0.15 × sequence(1) + 0.05 × speech(1)

ASR confidence A가 있으면 S = min(1, K + 0.15 × A)
없으면                    S = min(1, K / 0.85)

threshold = max(0.72, profile.thresholds.text ?? 0.82)
S >= threshold일 때만 승인
```

기본 임계치를 낮춘 것이 아니라, **정확한 선두 위치 + 변별성**을 먼저 검사한 증거에 위치 보너스를 준다. 예를 들어 A=0.2이면 S=0.955이므로, 작성된 profile 임계치가 0.99이면 차단한다. 이 점수는 의사결정 점수이지 보정된 음향 확률이 아니다.

이미 충분한 긴 증거가 있는 경우에는 기존 baseline 결과와 소비 범위를 우선 보존한다. 짧은 2~3음절 증거에서는 baseline fuzzy 탐색 전에 선두 증거를 평가한다. `earlyEvidence` telemetry에 위치 가중치, 경쟁 margin, 실제 threshold를 남긴다.

## 3. 핫패스와 파셜 수정 보호

- 엔진이 계산한 누적 정규화 문자열을 matcher context로 전달하여 반복적인 전체 문자열 정규화를 줄였다.
- canonical 정규화/첫 어절은 matcher 내 WeakMap에 캐시하고 같은 raw 입력의 토큰 분석을 재사용한다.
- `HypothesisCursor`는 append-only interim에서 suffix 검색·anchor 재배치 없이 바로 갱신한다.
- 조기 송출에 사용한 접두사가 같은 stream의 수정본에서 삭제/치환되면 수정본 전체를 checkpoint 처리한다. 이 수정본을 새 발화로 간주하여 다음 큐까지 연쇄 송출하지 않는다. 이후 새로운 발화나 소비되지 않은 신규 증거로 재개한다.
- 기존 단방향 NORMAL 탐색, 한 이벤트당 한 번의 trigger, 이전 큐 trailing-evidence 차단, 수동 이동/reset/HOLD/ARM/GO 보호를 유지한다.
- `validateLookaheadSkip`와 후보 탐색 폭은 변경하지 않았다. 짧은 선두 증거는 미래 큐에 적용하지 않는다. 기존 한 큐 누락 복구는 시간·4글자 이상 anchor·점수 0.90·경쟁 margin 등 모든 기존 조건을 만족할 때만 가능하며, 2개 이상의 큐 건너뛰기는 차단된다.
- fallback 설정, canonical 대본, reference 타임스탬프는 변경하지 않았다.

## 4. 브라우저 수신 경로

`use-script-follower`는 원래 디바운스가 없었다. 입력을 엔진에 동기 전달한 뒤 React 상태와 진단 로그를 갱신하도록 순서를 명확히 했다. `BrowserSpeechASRAdapter`에서는 trim을 한 번만 수행하고, 결과 인덱스의 filter/sort 임시 배열 대신 순서대로 누적 문맥을 구성한다. 수신 시각은 onresult 진입 시 기록한다. 결과 경계가 단어 경계라는 가정을 하지 않으며 기존 문맥 결합을 유지한다.

**0ms는 의도적으로 추가하는 대기 시간이 없다는 뜻이다.** ASR 서버의 첫 partial 생성 시간, 실제 CPU 처리 시간, React 렌더와 관객 화면 전송 지연까지 0이라는 뜻이 아니다. 재연결 타이머와 화면 paint 계측은 입력 디바운스가 아니므로 제거하지 않았다.

Next.js 스킬의 클라이언트 경계를 준수해 엔진 전달을 클라이언트 훅에 유지했고, 브라우저 검증 스킬로 화면 로딩·에러 오버레이·주요 컨트롤을 확인했다.

## 5. 검증

- `npm run typecheck`: 통과.
- `npm test`: 23개 파일, **246개 테스트 통과**. 기존 224개에서 22개 회귀 검증 추가.
- `npm run build`: 통과.
- `npm run test:e2e`: **36개 통과**, 로컬 원본을 요구하는 별도 실음원 테스트 1개는 기본 skip. 음원 타임라인, 라이브 입력, 모드 전환과 관객 송출 회귀가 통과했다. 이번 작업에서는 실음원 재생 테스트를 별도로 실행하지 않았다.
- `npm run test:backend`: 80개 통과, 환경 의존 1개 skip. 기존 dependency deprecation 경고 2개.
- `git diff --check`: 통과.
- 기존 "live 2음절은 항상 거부" 테스트는 이번 요구에 맞게 "고유한 선두 접두사는 승인, 공통/관계없는 발화는 거부"로 갱신했다. 안전성 테스트를 삭제하지 않았다.
- production `ShowRuntime`의 readiness/GO, 짧은 prefix 즉시 trigger, 기능어 대기, 경쟁 가사 차단, 파셜 취소, 중복/소비 증거, 미래 큐 차단, HOLD/manual/reset을 테스트했다.
- 브라우저 adapter 테스트는 fake timer를 진행하거나 microtask를 flush하지 않고, onresult 호출 직후 실제 production runtime 전진을 확인한다.
- 오퍼레이터 E2E는 "창가"라는 두 음절 interim만 주입하여 실제 `ShowRuntime`을 거쳐 `/output`에 M05-2_C001 canonical 자막이 도착하는지 확인한다. ASR 이벤트는 합성이지만 엔진과 관객 송출 경로는 실제 구현이다.

## 6. 개선 수치와 한계

합성 입력 도착 시각을 100ms("운"), 160ms("운명"), 250ms("운명이"), 700ms("운명이 이끄는")로 고정한 비교에서, 기본 프로덕션 matcher는 160ms에 송출했고 이전 `PrefixFuzzyMatcher`는 700ms에 송출했다. 이 사례의 **증거 대기 감소는 540ms**이다. 타임스탬프는 테스트 입력이며 라이브 성능 수치가 아니다.

별도 단일 테스트 실행에서 해당 조기 trigger 호출의 CPU 처리 시간은 약 0.038ms였다. 매우 작은 합성 사례의 관측값으로, 실음원/가창 P95나 보편적 속도 향상을 뜻하지 않는다. 실제 마이크·스트리밍 ASR를 새로 실측하거나 외부 오디오 API를 호출하지 않았다.

짧은 ASR partial 자체가 잘못될 위험을 없앨 수는 없다. 취소된 증거의 **추가 연쇄 전진은 차단**하지만 이미 송출된 첫 자막을 자동 되감지는 않는다. 기능어 목록은 형태소 분석기가 아니며, 변별성 검증은 기존 로컬 탐색 문맥에 한정한다. 실제 공연 투입 전 독립 오디오 onset 기준으로 false/early/miss와 partial revision을 재측정해야 한다.
