---
author: 짱현무
pubDatetime: 2026-07-17T15:03:00+09:00
title: ClickStack, HyperDX, OpenTelemetry Collector로 관측성 만들기
featured: false
draft: false
tags:
  - sre
  - observability
  - opentelemetry
  - clickstack
  - hyperdx
description: k3s에 ClickStack과 플랫폼 OpenTelemetry Collector를 배포하고 trace·metric·log를 ClickHouse와 HyperDX까지 연결한 구성과 검증 방법을 정리한다.
---

관측성 스택을 설치했다는 말은 UI가 열린다는 뜻이 아니다. 애플리케이션이 보낸 신호가 Collector에 도착하고, 백엔드에 저장되며, UI에서 다시 찾을 수 있어야 한다.

이 구성은 ClickStack의 HyperDX, ClickHouse, bundled Collector 앞에 별도의 platform OpenTelemetry Collector를 두었다.

## Table of contents

## 왜 Collector가 두 개인가

[ClickStack](https://github.com/ClickHouse/ClickStack)은 세 가지 핵심 구성요소를 가진다.

- ClickHouse: 로그, 메트릭, 트레이스 저장소
- HyperDX: 검색, 시각화, 알림 UI
- ClickStack Collector: ClickHouse 스키마에 맞는 ingestion gateway

애플리케이션이 ClickStack Collector를 직접 보게 할 수도 있다. 하지만 platform Collector를 하나 더 두면 애플리케이션은 플랫폼의 일관된 OTLP endpoint만 알면 된다. 후처리, resource attribute, sampling, backend 교체는 인프라 층에서 다룰 수 있다.

```text
apps / smoke / LiteLLM
        |
        | OTLP 4317, 4318
        v
platform-otel-collector
        |
        | OTLP HTTP
        v
clickstack-otel-collector
        |
        v
ClickHouse <----> HyperDX
```

## 자원 제한을 반영한 ClickStack

이는 단일 노드 홈 클러스터다. 그래서 가용성보다 다시 만들 수 있는 구성과 작은 자원 사용량을 우선했다.

| 구성요소             | v1 구성                        |
| -------------------- | ------------------------------ |
| HyperDX              | 1 replica, ClusterIP           |
| MongoDB              | 1-member ReplicaSet            |
| ClickHouse           | 1 shard, 1 replica, 20 GiB PVC |
| ClickHouse Keeper    | 1 replica, 2 GiB PVC           |
| ClickStack Collector | Deployment, 1 replica          |

구성은 ClickStack operator chart 1.0.0과 ClickStack chart 3.0.1에 고정했다. 신규 버전을 무조건 따라가지 않고 values와 smoke를 함께 검증한 뒤 올린다.

```bash
helm repo add clickstack \
  https://clickhouse.github.io/ClickStack-helm-charts
helm repo update

helm upgrade --install clickstack-operators \
  clickstack/clickstack-operators \
  --namespace observability \
  --version 1.0.0 \
  --wait

helm upgrade --install clickstack \
  clickstack/clickstack \
  --namespace observability \
  --version 3.0.1 \
  --values platform/values/clickstack.yaml \
  --wait
```

실제 배포에서 API key와 DB password는 values file에 넣지 않고 Git에 추적되지 않는 secret file에서 로드한다. 블로그나 shell history에 실제 `--set-string` 값을 남기지 않는다.

## platform Collector 구성

OpenTelemetry Collector chart 0.146.0과 `otel/opentelemetry-collector-k8s` image를 사용했다. [공식 Helm chart 문서](https://opentelemetry.io/docs/platforms/kubernetes/helm/collector/)처럼 `mode`를 반드시 명시한다.

```yaml
fullnameOverride: platform-otel-collector
mode: deployment
replicaCount: 1

image:
  repository: otel/opentelemetry-collector-k8s

ports:
  otlp:
    enabled: true
    containerPort: 4317
    servicePort: 4317
  otlp-http:
    enabled: true
    containerPort: 4318
    servicePort: 4318
```

receiver는 OTLP gRPC/HTTP와 Kubernetes event를 받고, exporter는 ClickStack Collector의 cluster-local OTLP HTTP endpoint를 본다.

```yaml
config:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
  processors:
    memory_limiter:
      check_interval: 5s
      limit_percentage: 80
      spike_limit_percentage: 20
    k8sattributes: {}
    batch: {}
  exporters:
    otlphttp/clickstack:
      endpoint: >-
        http://clickstack-otel-collector.observability.svc.cluster.local:4318
```

신호별 pipeline은 공통으로 memory limiter, Kubernetes attribute, batch processor를 거친다.

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [otlphttp/clickstack]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [otlphttp/clickstack]
    logs:
      receivers: [otlp, k8sobjects]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [otlphttp/clickstack]
```

## DaemonSet 글을 따로 내지 않은 이유

현재 실제 배포된 platform Collector는 `Deployment`다. single-node에서는 그 Pod가 유일한 node에 스케줄되므로 host log volume에 접근할 수 있다. 하지만 멀티노드로 확장하면 하나의 Deployment Pod는 다른 node의 container log file을 읽을 수 없다.

그 때는 Collector를 두 역할로 분리하는 것이 좋다.

```text
node A: Agent DaemonSet --+
node B: Agent DaemonSet --+--> Gateway Deployment --> ClickStack
node C: Agent DaemonSet --+
```

- Agent DaemonSet: 각 node의 `filelog`, kubeletstats, hostmetrics 수집
- Gateway Deployment: OTLP 수신, 중앙 처리, backend export
- Cluster receiver: Kubernetes event처럼 중복 수집하면 안 되는 신호는 하나의 역할만 담당

공식 chart의 `logsCollection` preset은 container stdout log를 수집할 때 `filelog` receiver와 host volume/RBAC를 준비해 준다. 다만 Collector 자신의 log를 다시 수집해 무한히 늘어나는 log loop를 피해야 한다. 이 전환은 아직 실기 검증하지 않았으므로 “DaemonSet으로 구성했다”는 독립 글은 발행하지 않았다.

## HyperDX 첫 로그인

```bash
kubectl -n observability port-forward \
  service/clickstack-app 8080:8080
```

`http://localhost:8080`에 처음 접속하면 로컬 운영자 계정을 만든다. 이 계정의 password는 ClickStack ingestion API key와 다르다. UI password는 password manager에 보관하고, `CLICKSTACK_API_KEY`를 로그인 password로 쓰지 않는다.

계정을 만든 뒤 chart가 구성한 ClickHouse source가 보이는지 확인한다.

## UI health보다 깊은 smoke test

검증 스크립트는 OTLP HTTP로 고유한 service name을 가진 trace, metric, log를 보낸다.

```text
service.name = home-ai-infra-smoke
span.name    = host-to-cluster-smoke
metric.name  = home_ai_infra_smoke
log.body     = home-ai-infra host-to-cluster smoke
```

그런 뒤 ClickHouse Pod에서 실제 row를 조회한다.

```sql
SELECT count()
FROM default.otel_traces
WHERE ServiceName = 'home-ai-infra-smoke'
  AND SpanName = 'host-to-cluster-smoke';

SELECT count()
FROM default.otel_metrics_gauge
WHERE ServiceName = 'home-ai-infra-smoke'
  AND MetricName = 'home_ai_infra_smoke';

SELECT count()
FROM default.otel_logs
WHERE ServiceName = 'home-ai-infra-smoke'
  AND Body = 'home-ai-infra host-to-cluster smoke';
```

세 query가 모두 1 이상일 때만 “관측성 경로가 살아 있다”고 판단한다.

```bash
make expose
make smoke
```

HyperDX에서는 최근 시간 범위를 선택하고 `home-ai-infra-smoke`를 검색해 같은 신호를 사용자 경로에서도 확인한다.

## 장애가 난 때의 순서

```bash
kubectl get pods,pvc -A
kubectl get events -A --sort-by=.lastTimestamp
kubectl -n observability logs \
  deploy/platform-otel-collector --tail=200
kubectl -n observability logs \
  deploy/clickstack-app --tail=200
```

UI가 안 열린다면 port-forward, Service, Pod 순서로 본다. UI는 열리지만 데이터가 없다면 platform Collector의 exporter error와 ClickStack Collector를 본다. ClickHouse와 MongoDB PVC를 원인 확인 없이 삭제하지 않는다.

## 다음 글

[Langfuse v3를 k3s에 Helm으로 셀프 호스팅하기](/posts/home-ai-platform-04-langfuse)
