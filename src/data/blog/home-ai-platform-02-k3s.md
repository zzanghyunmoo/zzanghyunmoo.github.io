---
author: 짱현무
pubDatetime: 2026-07-17T15:02:00+09:00
title: k3s를 개인 홈 서버에 선언적으로 설치하기
featured: false
draft: false
tags:
  - home-server
  - kubernetes
  - k3s
  - ansible
description: k3s 버전과 config.yaml을 고정하고 Ansible로 설치·재시작·readiness 확인까지 자동화한 개인용 single-node Kubernetes 구성을 설명한다.
---

Linux 실행면 위에 Kubernetes를 올릴 때 개인 서버에 필요한 것은 작은 바이너리만이 아니다. 버전이 예고 없이 바뀌지 않고, 호스트를 재시작한 뒤에도 돌아오며, 설정이 설치 명령에 숨어 있지 않아야 한다.

이 구성은 k3s `v1.36.2+k3s1`을 고정하고 `/etc/rancher/k3s/config.yaml`을 Ansible이 소유하게 했다.

## Table of contents

## 왜 k3s인가

k3s는 containerd, CNI, CoreDNS, local storage provider 등 개인 클러스터에 필요한 기본값을 함께 제공한다. [공식 quick start](https://docs.k3s.io/quick-start)의 installer는 systemd 서비스 설치와 kubeconfig 생성까지 처리한다.

하지만 단순히 다음 명령만 남기면 나중에 어떤 옵션으로 설치했는지 알기 어렵다.

```bash
curl -sfL https://get.k3s.io | sh -
```

그래서 installer는 바이너리와 service를 준비하는 수단으로만 쓰고, 지속해야 할 설정은 YAML로 분리했다. [k3s configuration 문서](https://docs.k3s.io/installation/configuration)도 installer를 재실행할 때 기존 flag가 사라질 수 있으므로 지속적인 설정에는 config file을 권한다.

## config.yaml에 담은 운영 의도

```yaml
write-kubeconfig-mode: "0640"
node-name: home-ai-infra-macos
tls-san:
  - "127.0.0.1"
  - "localhost"
disable:
  - traefik
  - servicelb
node-label:
  - home-ai-infra/platform=generic
secrets-encryption: true
protect-kernel-defaults: false
```

### localhost를 TLS SAN에 넣기

Lima VM의 kubeconfig를 macOS host로 복사한 뒤 Kubernetes API에 `127.0.0.1`로 접속한다. 인증서의 SAN에 localhost가 없으면 이름 검증에서 실패한다.

### Traefik과 ServiceLB 끄기

v1의 UI는 모두 localhost port-forward로만 연다. Ingress와 LoadBalancer 구현은 아직 필요하지 않으므로 k3s 번들 Traefik과 ServiceLB를 끄어 자원과 공개 표면을 줄였다.

### secrets encryption 켜기

Kubernetes Secret은 기본적으로 base64 encoding이지 암호화가 아니다. `secrets-encryption: true`를 켜서 datastore에 저장되는 Secret을 암호화한다. 다만 이 옵션이 backup 암호화나 host 보안을 대체하는 것은 아니다.

## Ansible로 버전을 고정하기

버전은 `versions.lock.env`에 한 번만 적는다.

```bash
K3S_VERSION='v1.36.2+k3s1'
```

Ansible task는 현재 설치 버전을 읽고, 다를 때만 공식 installer를 받아 `INSTALL_K3S_VERSION`으로 고정한다.

```yaml
- name: Install the pinned k3s release
  ansible.builtin.command: /usr/local/src/install-k3s.sh
  environment:
    INSTALL_K3S_VERSION: "{{ k3s_version }}"
    INSTALL_K3S_EXEC: server
  when: k3s_version not in installed_k3s.stdout
  notify: Restart k3s
```

설정 template이 바뀌면 handler가 k3s를 재시작한다. 그 다음에 API port와 node readiness를 순서대로 기다린다.

```bash
sudo systemctl is-enabled k3s
sudo systemctl is-active k3s
sudo k3s kubectl wait \
  --for=condition=Ready node --all --timeout=180s
```

여기서 중요한 점은 “installer가 종료됐다”와 “node가 Ready다”를 같은 것으로 보지 않는 것이다.

## kubeconfig은 호스트별로 자르기

Mac에서는 guest의 kubeconfig를 host 저장소로 복사한다.

```bash
limactl shell home-ai-infra \
  sudo cat /etc/rancher/k3s/k3s.yaml > .state/kubeconfig
chmod 0600 .state/kubeconfig
```

Windows WSL2는 Linux 안에서 바로 k3s에 접속하므로 같은 파일을 WSL 환경에서 사용한다. 두 host의 kubeconfig를 무심코 하나로 덮어쓰지 않는 것이 좋다. 서로 다른 클러스터이기 때문이다.

## 검증은 네 층으로

### 1. service

```bash
sudo systemctl status k3s
```

### 2. node

```bash
kubectl get nodes -o wide
```

### 3. platform object

```bash
kubectl get pods,pvc -A
helm list -A
```

### 4. 사용자 경로

```bash
make expose
make smoke
```

service가 살아 있어도 node가 NotReady일 수 있고, node가 Ready여도 workload가 Pending일 수 있다. 마지막으로 workload가 Running이어도 호스트에서 접근할 수 없거나 템레메트리가 저장되지 않을 수 있다. 각 층을 나눠 확인해야 한다.

## 삭제 명령을 기본 타겟으로 만들지 않기

실험 클러스터라도 VM, WSL distro, PVC를 한 번에 지우는 `make clean`은 두지 않았다. 데이터 삭제는 backup 여부와 대상을 확인해야 하는 운영 작업이다. 설치 자동화와 파괴 자동화는 같은 편의성으로 다루면 안 된다.

## 다음 글

[ClickStack, HyperDX, OpenTelemetry Collector로 관측성 만들기](/posts/home-ai-platform-03-clickstack-otel)
