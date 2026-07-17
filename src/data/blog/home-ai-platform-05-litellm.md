---
author: 짱현무
pubDatetime: 2026-07-17T15:05:00+09:00
title: LiteLLM Proxy를 k3s에 설치해 LLM 게이트웨이 만들기
featured: false
draft: false
tags:
  - ai-platform
  - litellm
  - kubernetes
  - helm
  - llm-gateway
description: LiteLLM Proxy와 PostgreSQL을 k3s에 Helm으로 배포하고 master key, Dashboard 로그인, model list, health 검증의 경계를 정리한다.
---

여러 model provider를 애플리케이션에 직접 연결하면 API key, model name, rate limit, budget, retry, 관측성 설정이 각 서비스로 퍼진다. LiteLLM Proxy는 OpenAI-compatible API를 제공하면서 이 정책들을 게이트웨이로 모은다.

이 구성은 LiteLLM chart 1.92.0, app v1.92.0을 사용했다.

## Table of contents

## 현재 범위를 먼저 명확히 하기

v1의 목표는 gateway 기반을 올리고 운영 경로를 검증하는 것이다. 따라서 `model_list`는 의도적으로 비어 있다.

```yaml
proxy_config:
  model_list: []
```

이 상태에서도 다음은 검증할 수 있다.

- LiteLLM Pod와 PostgreSQL이 정상 시작한다.
- Dashboard에 master key로 로그인할 수 있다.
- liveliness endpoint가 성공한다.
- 인증된 `/v1/models`가 빈 목록을 반환한다.

하지만 실제 completion은 수행할 수 없다. Ollama도 설치되어 있지 않다. 플랫폼 성공과 추론 성공을 구분해야 한다.

## 기본 Helm values

```yaml
replicaCount: 1

image:
  repository: ghcr.io/berriai/litellm-database
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 4000

resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    cpu: "1"
    memory: 2Gi
```

외부에 직접 노출하지 않고 `ClusterIP` Service와 port-forward를 쓴다. 인증은 `PROXY_MASTER_KEY`를 참조하도록 구성한다.

```yaml
proxy_config:
  general_settings:
    master_key: os.environ/PROXY_MASTER_KEY
  litellm_settings:
    drop_params: true
```

master key를 values.yaml에 직접 쓰지 않는다. Git에 추적되지 않는 secret file에서 생성하고 chart에 주입한다.

```bash
make secrets
```

## 상태 저장을 위한 PostgreSQL

Dashboard 상태, virtual key, budget 등을 저장하기 위해 standalone PostgreSQL을 함께 배포한다.

```yaml
db:
  deployStandalone: true

postgresql:
  architecture: standalone
  primary:
    persistence:
      enabled: true
      size: 8Gi
    resourcesPreset: small

migrationJob:
  enabled: true
```

전용 운영 DB가 있다면 외부 PostgreSQL로 분리할 수 있다. 하지만 개인용 single-node v1은 재현 가능성을 위해 chart 내부 의존성을 택했다.

## 버전을 고정해 배포하기

LiteLLM Helm chart는 OCI registry에서 가져온다.

```bash
helm upgrade --install litellm \
  oci://ghcr.io/berriai/litellm-helm \
  --namespace ai-system \
  --version 1.92.0 \
  --values platform/values/litellm.yaml \
  --wait \
  --timeout 15m
```

실제 스크립트는 master key와 PostgreSQL password를 secret file에서 로드해 chart에 전달한다. 터미널 log나 CI output에 값을 출력하지 않도록 주의한다.

```bash
kubectl -n ai-system get pods,pvc
kubectl -n ai-system logs deploy/litellm --tail=200
```

## Dashboard 첫 로그인

```bash
kubectl -n ai-system port-forward \
  service/litellm 4000:4000
```

`http://localhost:4000/ui/`에 접속한다.

- username: `admin`
- password: 로컬 secret file의 `LITELLM_MASTER_KEY`

master key는 단순 UI password가 아니라 proxy API의 전체 권한을 가진 비밀값이다. 문서나 screenshot에 남기지 않는다.

## health와 model list 확인

```bash
curl --fail http://localhost:4000/health/liveliness
```

인증이 필요한 endpoint는 key를 header에 넣어 호출한다.

```bash
set -a
source .secrets/home.env
set +a

curl --fail \
  --header "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  http://localhost:4000/v1/models
```

현재 정상 결과는 빈 model list다. HTTP 200이라도 model이 없다면 completion은 불가능하다.

## provider를 추가할 때의 원칙

[공식 LiteLLM 문서](https://docs.litellm.ai/)의 `model_list` 구조를 따르되, 다음을 한 변경으로 묶는다.

1. provider API key를 Kubernetes Secret에 추가한다.
2. `model_list` alias와 provider model을 추가한다.
3. 예산, rate limit, timeout을 정한다.
4. 검증용 completion을 보낸다.
5. Langfuse trace와 HyperDX의 OTel signal을 확인한다.

key만 추가하거나 model config만 추가하면 불완전한 배포가 된다.

## 다음 글

[LiteLLM 관측성 이중화: Langfuse와 OpenTelemetry 연결하기](/posts/home-ai-platform-06-litellm-observability)
