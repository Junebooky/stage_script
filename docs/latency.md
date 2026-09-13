# Latency: 무엇을 측정했는가

ASR의 문장 완료와 자막 송출은 다른 사건입니다. interim이어도 충분한 canonical evidence가 있으면 즉시 송출합니다. Final/silence/cooldown은 gate가 아닙니다. **ASR이 처음 증거를 전달할 때까지의 시간 자체를 프런트엔드가 없앨 수는 없습니다.**

## 현재 측정 경계

| 표시 | 시작 | 끝 | 포함하지 않는 시간 |
| --- | --- | --- | --- |
| Demo 음성→표시 | 브라우저가 받은 VAD onset | caption commit 이후 paint 추정 | 실제 발화→VAD 검출 전, 프로젝터 |
| Demo 인식→표시 | ASR 수신 | 동일 | **ASR 대기 전체**, 프로젝터 |
| Demo 수동→표시 | 수동 트리거 | 동일 | 음성/ASR, 프로젝터 |
| Operator …→미리보기 | 위와 같은 원점 구분 | 운영 창 preview paint 추정 | 관객 전송/paint, HDMI/프로젝터 |
| Rehearsal replay P50/P95 | 관측 cue onset | 재생 engine trigger 시각 | 실제 추론 시간, UI/물리적 출력 |

Paint는 commit 이후 두 requestAnimationFrame으로 근사하며 **자막 표시를 지연시키지 않습니다**. Demo는 basis별 최대 500건의 P50/P95/P99를 계산하고 basis 변경 시 초기화합니다. Operator는 마지막 preview 값을 보여줍니다. 관객 ACK는 렌더 준비 상태이지 광학적 표시 시각이 아닙니다.

브라우저는 performance.now()를 사용합니다. 서버 monotonic clock과 시작점이 달라 뺄셈하지 않습니다. 연속 발화에는 매 줄 새 VAD가 없으므로 onset은 다음 cue가 한 번만 소비하고 이후는 인식 basis를 표시합니다. 독백 시작 시각을 재사용하거나 가상의 음절 onset을 만들지 않습니다.

## 지연 방지

- DEMO next cue는 2음절 일치에서 동기 판정하고 한 글자는 송출하지 않습니다.
- 누적 interim/final 수정에 cursor를 재배치하여 이전 문장 완성 없이 다음 대사 evidence를 사용합니다.
- default inter-cue cooldown은 0입니다. 유효한 단일 업데이트를 시간 lock으로 놓치지 않습니다.
- 공연 모드는 충돌/오송출 방지를 위해 더 강한 prefix/internal evidence를 요구합니다. Demo의 2음절 정책과 분리합니다.
- 수동 큐는 reset ACK를 기다리지 않습니다. 자동 인식만 새 오디오 세대를 확인할 때까지 닫습니다.
- 관객 ACK 대기 중 마지막 신규 hypothesis를 보류하고, 수동 조작은 이를 폐기합니다.

## 실제 로컬 ASR 비용

| 단계 | 구현 |
| --- | --- |
| PCM | 16 kHz mono, 320 samples / 20 ms |
| 첫 추론 버퍼 | 최소 400 ms |
| 다음 추론 간격 | 최소 320 ms, 이전 작업 완료 필요 |
| rolling window | 최대 12초, 동시 추론 1개 |
| final 기준 | 약 600 ms silence, cue는 interim 사용 |
| 결과 polling | WS loop 최대 약 40 ms 대기 |
| 모델 계산 | 장비/모델에 따라 달라짐, 이번에 실측하지 않음 |

현재 faster-whisper에 150 ms 이하 음향 end-to-end를 약속할 수 없습니다. 실제 모델 연결을 구현한 것이지 초저지연 음소 streaming recognizer가 아닙니다. CPU 추론이 오래 걸리면 새 세대도 기존 native 작업의 lock 해제를 기다릴 수 있습니다. 초저지연은 한국어 streaming CTC/transducer와 실제 가창 녹음으로 별도 비교해야 합니다.

## 테스트의 의미

브라우저 회귀는 실제 AudioWorklet과 합성 PCM/주입 ASR을 사용합니다. Demo 16개를 final 0회, 수동 0회로 넘기고 주입→paint 200 ms 미만을 검증합니다. 연속 수정, 늦은 final, reset/HOLD, generation ACK, audience ordering/재접속도 확인합니다. 이는 앱 처리 지연이며 실제 음향 인식 속도/정확도가 아닙니다.

Rehearsal replay는 receivedAtMs가 없으면 word 끝 또는 segment 끝을 전달 시각으로 가정하여 simulated-asr-delivery로 표시합니다. 모든 실제 수신 시각이 있으면 recorded-asr-delivery입니다. 자동 정렬은 pseudo로 남습니다. 음수 cue error는 일찍 송출된 것이며 단독으로 속도 개선이라고 해석하지 않습니다.

## 실공연 승인 전 측정

1. 실제 공연 노트북에 모델/에셋을 준비하고 예열 후 인터넷을 끊습니다.
2. 대사/가창/긴 모음/반주/합창/overlap/반복 가사/생략/수동 복구를 포함해 200개 이상 cue를 수집합니다.
3. 독립 검토자가 음원에서 cue onset과 정답을 확인합니다. 보정에 쓰지 않은 리허설을 포함합니다.
4. PCM sequence, 수집 시각, ASR 시작/종료, matcher, audience paint에 trace ID와 clock offset 측정을 추가합니다. 현재 이 전체 trace는 미구현입니다.
5. 외부 녹화/광학 측정으로 음향 onset→HDMI/프로젝터 표시를 확인하고 P50/P95/P99 및 miss/wrong/early/late를 함께 보고합니다.
6. 장시간 CPU/GPU 부하, USB 입력 재연결, audience 재시작, ASR 중단, 수동 우선권, 막 경계, 이미지 누락을 시험합니다.

이전 150/250 ms 목표는 제품 목표일 뿐 현재 로컬 모델의 실측 또는 보장값이 아닙니다.
