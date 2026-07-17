---
author: 짱현무
pubDatetime: 2026-07-17T15:06:00+09:00
title: "LiteLLM 관측성 이중화: Langfuse와 OpenTelemetry 연결하기"
featured: false
draft: false
tags:
  - ai-platform
  - litellm
  - langfuse
  - opentelemetry
  - llm-observability
description: LiteLLM의 LLM 도메인 trace는 Langfuse로, 표준 OpenTelemetry trace·metric은 ClickStack으로 보내는 이중 관측성 경로를 구성한다.
---

LiteLLM을 설치한 뒤 다음 질문은 “요청이 실패했을 때 어디서 볼 것인가”다. Kubernetes log만으로는 프로바이더 latency, token, cost, generation의 관계를 살피기 어렵다. 반대로 LLM 전용 관측 도구만으로는 프록시 Pod의 자원과 플랫폼 이벤트를 함께 보기 어렵다.

그래서 하나의 요청을 두 관점으로 보낸다.

## Table of contents

## 두 backend의 역할을 나누기

```text
client
  |
  v
LiteLLM
  |- Langfuse callback --------> Langfuse
  |   generation, usage, cost     LLM analysis
  |
  `- OpenTelemetry -----------> platform Collector -> ClickStack
      traces, metrics              system analysis
```

Langfuse는 LLM 요청 하나의 input/output, generation, token, latency, cost, feedback을 이해한다. ClickStack은 같은 시간대의 Kubernetes event, container log, service trace, metric을 함께 보는 데 적합하다.

두 백엔드를 경쟁시키지 않고 문제의 축을 나눠 담당하게 했다.

## Langfuse callback 연결

LiteLLM은 `success_callback`과 `failure_callback`으로 Langfuse에 LLM event를 보낼 수 있다. [LiteLLM 공식 문서](https://docs.litellm.ai/)에서도 Langfuse를 기본 observability integration으로 제공한다.

```yaml
proxy_config:
  litellm_settings:
    success_callback:
      - langfuse
    failure_callback:
      - langfuse
    turn_off_message_logging: true
```

Langfuse host는 Kubernetes service DNS를 쓴다.

```yaml
envVars:
  LANGFUSE_HOST: >-
    http://langfuse-web.langfuse.svc.cluster.local:3000
```

public/secret key는 Langfuse headless initialization에서 만든 프로젝트 key와 같은 값이다. 평문 YAML에 넣지 않고 Kubernetes Secret으로 주입한다.

```bash
kubectl create secret generic home-ai-litellm-telemetry \
  --namespace ai-system \
  --from-literal="LANGFUSE_PUBLIC_KEY=..." \
  --from-literal="LANGFUSE_SECRET_KEY=..." \
  --dry-run=client \
  --output yaml | kubectl apply -f -
```

```yaml
environmentSecrets:
  - home-ai-litellm-telemetry
```

## 메시지 본문을 기본적으로 기록하지 않기

LLM input과 output에는 개인정보, 소스코드, 사내 문서, secret이 포함될 수 있다. 관측성을 켰다고 모든 본문을 자동 수집하면 새로운 유출 표면을 만든다.

그래서 v1은 LiteLLM의 message logging을 끄고 OpenTelemetry GenAI instrumentation도 message content를 캡처하지 않게 했다.

```yaml
envVars:
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: no_content
```

이 선택은 prompt debugging 편의를 줄이지만 안전한 기본값을 제공한다. 나중에 본문 수집이 필요하다면 무작정 전체를 켜기보다 masking, retention, access control, 대상 모델을 함께 설계해야 한다.

## OpenTelemetry 연결

LiteLLM의 표준 trace와 metric은 platform Collector로 보낸다.

```yaml
envVars:
  LITELLM_OTEL_V2: "true"
  LITELLM_OTEL_INTEGRATION_ENABLE_METRICS: "true"
  OTEL_EXPORTER: otlp_http
  OTEL_ENDPOINT: >-
    http://platform-otel-collector.observability.svc.cluster.local:4318
  OTEL_SERVICE_NAME: litellm
  OTEL_ENVIRONMENT_NAME: home
```

애플리케이션이 ClickStack의 내부 구조를 알지 않도록 platform Collector service를 본다. Collector가 resource attribute를 보강하고 batch 처리한 후 ClickStack Collector로 export한다.

## 배포 순서가 계약이다

LiteLLM이 시작할 때 두 destination이 먼저 준비되어 있어야 한다.

1. namespace와 Secret을 만든다.
2. ClickStack을 배포한다.
3. platform OTel Collector를 배포한다.
4. Langfuse를 배포하고 health를 확인한다.
5. 마지막에 LiteLLM을 배포한다.

이 순서를 배포 스크립트에 고정하면 callback 대상이 없는 상태에서 LiteLLM을 먼저 올리는 불필요한 실패를 줄일 수 있다.

## 어떤 화면에서 무엇을 볼까

| 질문                                     | 보기 좋은 곳       |
| ---------------------------------------- | ------------------ |
| 이 요청이 어떤 model/provider를 썼나?    | Langfuse           |
| token과 cost는 얼마나?                   | Langfuse           |
| 요청이 어느 generation에서 실패했나?     | Langfuse           |
| LiteLLM Pod의 CPU/memory가 부족한가?     | HyperDX/Kubernetes |
| 같은 시간대에 재시작이나 event가 있었나? | HyperDX/Kubernetes |
| OTLP export가 실패했나?                  | Collector log      |
| model/key/budget 설정은 정상인가?        | LiteLLM Dashboard  |

도구를 많이 설치하는 것보다 질문의 종류에 따라 첫 화면을 정해 두는 것이 중요하다.

## 현재 검증할 수 있는 것과 없는 것

현재 model provider가 없기 때문에 실제 LLM generation과 Langfuse trace는 아직 없는 것이 정상이다. 대신 다음은 검증했다.

- Langfuse와 LiteLLM health
- LiteLLM Dashboard 인증
- platform Collector의 OTLP gRPC/HTTP 수신
- 검증용 trace·metric·log의 ClickHouse 적재

provider를 추가한 뒤에는 다음 검증을 반드시 추가해야 한다.

1. LiteLLM을 통한 실제 completion 성공
2. Langfuse에 generation, latency, usage 생성
3. HyperDX에 `service.name=litellm` 신호 생성
4. message content가 의도한 정책대로 제외됐는지 확인

## 마무리

관측성은 백엔드 하나를 고르는 문제가 아니라, 어떤 질문을 어떤 데이터로 답할지 정하는 문제다. LLM 도메인은 Langfuse, 플랫폼 전반은 OpenTelemetry와 ClickStack으로 나누면 인프라 장애와 model 품질 문제를 같은 화면에 억지로 섞지 않아도 된다.

[시리즈 첫 글로 돌아가기](/posts/home-ai-platform-series)
