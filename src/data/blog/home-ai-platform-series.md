---
author: 짱현무
pubDatetime: 2026-07-17T15:00:00+09:00
title: "개인 홈 AI 플랫폼 만들기: 전체 구조와 운영 원칙"
featured: true
draft: false
tags:
  - home-server
  - kubernetes
  - observability
  - ai-platform
description: macOS와 Windows에 Linux 실행면을 만들고 k3s, ClickStack, Langfuse, LiteLLM을 올린 개인용 AI 플랫폼의 전체 설계와 검증 범위를 정리한다.
---

개발용 Mac과 GPU가 있는 Windows PC를 하나의 Kubernetes 클러스터로 묶으면 얼핏 멋져 보인다. 하지만 노트북은 잠들고, Windows는 업데이트 뒤 재부팅하며, 집 네트워크는 항상 안정적이지 않다. 그래서 첫 버전의 목표를 “멀티노드 클러스터”가 아니라 “같은 선언으로 다시 만들 수 있는 독립 클러스터”로 잡았다.

이 글은 그 결과를 설명하는 6개 실전 글의 시작점이다. 실제 소스는 [`home-ai-infra` 스냅샷](https://github.com/zzanghyunmoo/home-ai-infra/tree/518ff19c142d8a829a3e67edf2edb5f95427b120)에 고정해 뒀다.

## Table of contents

## 완성한 구조

```text
macOS host                         Windows host
  | localhost                       | localhost
  v                                 v
Lima Ubuntu VM                    WSL2 Ubuntu
  |                                 |
  +------ Ansible: Ubuntu + k3s -----+
              |
              v
       single-node k3s
       |- ai-system: LiteLLM
       |- langfuse: Langfuse + data stores
       `- observability
          |- platform OTel Collector
          `- ClickStack
             |- ClickStack Collector
             |- ClickHouse
             `- HyperDX
```

Mac과 Windows는 각각 single-node k3s를 가진다. 서로 가입하지 않으므로 한쪽이 잠들어도 다른 쪽의 control plane에 영향을 주지 않는다. Windows의 NVIDIA runtime과 device plugin도 기반만 준비했다. Ollama, 모델, inference workload는 아직 설치하지 않았다.

호스트에서는 모든 서비스를 `ClusterIP`로 두고 `kubectl port-forward`로만 접근한다.

| 서비스    | 로컬 주소               | 역할                       |
| --------- | ----------------------- | -------------------------- |
| LiteLLM   | `http://localhost:4000` | LLM gateway                |
| Langfuse  | `http://localhost:3000` | LLM trace·비용·품질 분석   |
| HyperDX   | `http://localhost:8080` | 일반 trace·metric·log 탐색 |
| OTLP gRPC | `localhost:4317`        | 템레메트리 수신            |
| OTLP HTTP | `localhost:4318`        | 템레메트리 수신            |

DB, Kubernetes API, 관측성 백엔드 포트를 LAN에 직접 노출하지 않는 것이 v1의 보안 경계다.

## 왜 이 조합을 골랐나

### Lima와 WSL2

Kubernetes는 Linux 기반으로 운영할 때 가장 단순하다. macOS에서는 Lima가 Linux VM을, Windows에서는 WSL2가 Linux 실행면을 담당한다. 호스트마다 다른 부트스트랩을 쓰되, VM 안에 들어온 뒤는 같은 Ansible role로 수렴한다.

### k3s

k3s는 단일 바이너리와 기본 containerd를 제공한다. 이 구성에서는 추가 ingress나 LoadBalancer가 필요하지 않아 번들 Traefik과 ServiceLB를 끄고 자원을 줄였다.

### ClickStack과 Langfuse

관측 도구를 하나로 합치지 않았다. HyperDX와 ClickHouse로 구성된 ClickStack은 시스템·애플리케이션의 일반 OpenTelemetry 신호를 본다. Langfuse는 LLM generation, token, latency, cost처럼 LLM 도메인에 특화된 정보를 담당한다.

### LiteLLM

LiteLLM을 통해 model provider 선택, 가상 key, budget, rate limit, callback을 한 곳에서 관리한다. v1은 플랫폼 기반이 목표라 `model_list` 자체는 비어 있다.

## 글 목록

1. [macOS Lima와 Windows WSL2로 Linux 실행면 만들기](/posts/home-ai-platform-01-lima-wsl)
2. [k3s를 개인 홈 서버에 선언적으로 설치하기](/posts/home-ai-platform-02-k3s)
3. [ClickStack, HyperDX, OpenTelemetry Collector로 관측성 만들기](/posts/home-ai-platform-03-clickstack-otel)
4. [Langfuse v3를 k3s에 Helm으로 셀프 호스팅하기](/posts/home-ai-platform-04-langfuse)
5. [LiteLLM Proxy를 k3s에 설치해 LLM 게이트웨이 만들기](/posts/home-ai-platform-05-litellm)
6. [LiteLLM 관측성 이중화: Langfuse와 OpenTelemetry 연결하기](/posts/home-ai-platform-06-litellm-observability)

## 검증의 경계

2026년 7월 17일 기준으로 macOS Lima 환경은 다음을 실제로 통과했다.

- Lima VM 생성과 k3s node `Ready`
- Helm release, Pod, PVC 정상 상태
- LiteLLM, Langfuse, HyperDX health
- 로컬 OTLP HTTP에서 trace·metric·log 전송
- ClickHouse OTEL 테이블의 실제 row 적재

Windows WSL2와 RTX 4060 경로는 구현과 정적 검증까지 완료했지만 실제 Windows host에서는 아직 돌리지 않았다. 해당 글의 Windows 부분은 이 상태를 명시한다.

## 운영의 시작은 설치 성공 다음이다

설치가 끝난 뒤에는 평소 `status → expose → smoke`만 반복하면 된다.

```bash
make status
make expose
make smoke
```

`make expose`는 포트포워드만 시작하고, `make smoke`는 UI health에서 끝나지 않고 ClickHouse 적재까지 확인한다. 이 플랫폼의 핵심은 많은 도구를 설치한 것이 아니라, 실패 지점을 바로 찾을 수 있는 검증 경로를 만든 것이다.
