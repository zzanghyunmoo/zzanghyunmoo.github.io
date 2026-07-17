---
author: 짱현무
pubDatetime: 2026-07-17T15:04:00+09:00
title: Langfuse v3를 k3s에 Helm으로 셀프 호스팅하기
featured: false
draft: false
tags:
  - ai-platform
  - langfuse
  - kubernetes
  - helm
  - llm-observability
description: Langfuse v3와 PostgreSQL·Redis·ClickHouse·S3 의존성을 k3s에 Helm으로 설치하고 headless 초기화와 첫 로그인까지 구성한다.
---

Langfuse는 LLM 요청의 trace, generation, latency, token usage, cost, score를 탐색하기 위한 도구다. 단일 web 애플리케이션처럼 보이지만 v3를 셀프 호스팅하려면 web, worker 외에도 여러 데이터 서비스가 필요하다.

이 글은 Langfuse chart 1.5.39, app 3.212.0을 기준으로 한다.

## Table of contents

## 먼저 자원 비용을 이해하기

[Langfuse 공식 self-hosting 문서](https://langfuse.com/self-hosting)에 따르면 v3는 다음 구성요소를 사용한다.

- Langfuse Web: UI와 API
- Langfuse Worker: 비동기 작업
- PostgreSQL: 트랜잭션 데이터
- ClickHouse: trace, observation, score 분석 데이터
- Redis/Valkey: queue와 cache
- S3-compatible object storage: event, media, export 저장

따라서 “Langfuse Pod 하나”를 예상하고 2 GiB VM에 올리면 자원 부족을 만나기 쉽다. 이 홈 클러스터는 전체 VM에 16 GiB 이상을 할당하고, 각 의존성을 standalone 1 replica로 줄였다. 개인 환경을 위한 선택이지 HA 구성은 아니다.

## Helm chart 준비

[공식 Kubernetes Helm 가이드](https://langfuse.com/self-hosting/deployment/kubernetes-helm)에서 제공하는 chart repository를 추가한다.

```bash
helm repo add langfuse https://langfuse.github.io/langfuse-k8s
helm repo update
kubectl create namespace langfuse
```

values에서는 signup과 사용 통계를 끄고 localhost URL을 명시했다.

```yaml
langfuse:
  logging:
    level: info
    format: json
  features:
    telemetryEnabled: false
    signUpDisabled: true
  nextauth:
    url: http://localhost:3000
  replicas: 1
```

`NEXTAUTH_URL`은 브라우저가 실제로 접속하는 URL과 맞아야 한다. 이 환경은 ingress 대신 localhost port-forward를 쓰므로 `http://localhost:3000`이다.

## 데이터 의존성과 PVC

```yaml
postgresql:
  deploy: true
  architecture: standalone
  primary:
    persistence:
      enabled: true
      size: 8Gi

redis:
  deploy: true
  architecture: standalone
  primary:
    persistence:
      enabled: true
      size: 2Gi

clickhouse:
  deploy: true
  shards: 1
  replicaCount: 1
  persistence:
    enabled: true
    size: 10Gi
  zookeeper:
    replicaCount: 1
    persistence:
      enabled: true
      size: 2Gi

s3:
  deploy: true
  persistence:
    enabled: true
    size: 5Gi
```

이는 백업 없이 안전하다는 뜻이 아니다. PVC는 Pod 재시작에 대한 지속성만 제공한다. VM disk가 손상되거나 PVC를 삭제하면 데이터를 잃을 수 있다.

## Secret은 values.yaml에 쓰지 않기

Langfuse에는 여러 종류의 secret이 필요하다.

- NextAuth secret
- salt
- 256-bit encryption key
- PostgreSQL, Redis, ClickHouse, S3 password
- 초기 사용자 password
- 프로젝트 public/secret key

이 값들은 Git에 추적되지 않는 `.secrets/home.env`에 두고 Kubernetes Secret으로 재조정한다.

```bash
make secrets

kubectl create secret generic home-ai-langfuse-bootstrap \
  --namespace langfuse \
  --from-literal="LANGFUSE_INIT_PROJECT_PUBLIC_KEY=..." \
  --from-literal="LANGFUSE_INIT_PROJECT_SECRET_KEY=..." \
  --from-literal="LANGFUSE_INIT_USER_PASSWORD=..." \
  --dry-run=client \
  --output yaml | kubectl apply -f -
```

위 예시의 `...`를 실제 shell history에 직접 입력하기보다, 외부에 노출되지 않는 배포 스크립트나 secret manager를 사용하는 것이 좋다.

## Headless initialization으로 첫 상태를 선언하기

운영자가 UI를 열어 organization과 project를 수동으로 만들면 재배포 절차가 완전히 자동화되지 않는다. Langfuse의 [headless initialization](https://langfuse.com/self-hosting/administration/headless-initialization)을 쓰면 첫 시작 시 organization, project, user를 생성할 수 있다.

```yaml
additionalEnv:
  - name: LANGFUSE_INIT_ORG_ID
    value: home-ai
  - name: LANGFUSE_INIT_ORG_NAME
    value: Home AI
  - name: LANGFUSE_INIT_PROJECT_ID
    value: home-ai-platform
  - name: LANGFUSE_INIT_PROJECT_NAME
    value: Home AI Platform
  - name: LANGFUSE_INIT_USER_EMAIL
    value: admin@home-ai.local
  - name: LANGFUSE_INIT_USER_NAME
    value: Home AI Admin
additionalEnvFrom:
  - secretRef:
      name: home-ai-langfuse-bootstrap
```

프로젝트 key와 user password는 Secret에서 주입한다. 이 초기화 값은 기존 사용자 password를 매 배포마다 바꾸는 수단이 아니다. 이미 생성된 계정의 password는 Langfuse의 인증 절차로 변경해야 한다.

## 배포하기

```bash
helm upgrade --install langfuse langfuse/langfuse \
  --namespace langfuse \
  --version 1.5.39 \
  --values platform/values/langfuse.yaml \
  --wait \
  --timeout 20m
```

chart가 의존 서비스를 처음 생성할 때 web과 worker가 몇 번 재시작될 수 있다. 단순히 첫 `kubectl get pods`의 재시작만 보고 실패로 판단하지 말고 rollout과 event를 함께 본다.

```bash
kubectl -n langfuse get pods,pvc
kubectl -n langfuse get events --sort-by=.lastTimestamp
kubectl -n langfuse logs deploy/langfuse-web --tail=200
kubectl -n langfuse logs deploy/langfuse-worker --tail=200
```

## 첫 로그인과 health

```bash
kubectl -n langfuse port-forward \
  service/langfuse-web 3000:3000
```

`http://localhost:3000/auth/sign-in`으로 접속한다.

- email: `admin@home-ai.local`
- password: 로컬 secret file의 `LANGFUSE_INIT_USER_PASSWORD`
- organization: `Home AI`
- project: `Home AI Platform`

password를 문서, 채팅, screenshot에 남기지 않는다.

API health는 다음처럼 확인한다.

```bash
curl --fail http://localhost:3000/api/public/health
```

UI health가 통과했다면 다음 단계는 LLM gateway에서 실제 trace를 보내는 것이다.

## 다음 글

[LiteLLM Proxy를 k3s에 설치해 LLM 게이트웨이 만들기](/posts/home-ai-platform-05-litellm)
