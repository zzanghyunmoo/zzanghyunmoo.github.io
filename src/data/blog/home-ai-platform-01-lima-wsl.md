---
author: 짱현무
pubDatetime: 2026-07-17T15:01:00+09:00
title: macOS Lima와 Windows WSL2로 Linux 실행면 만들기
featured: false
draft: false
tags:
  - home-server
  - lima
  - wsl
  - terraform
  - ansible
description: macOS에서는 Lima, Windows에서는 WSL2를 쓰고 공통 Ansible 구성으로 수렴시켜 k3s용 Linux 실행면을 만든 과정을 정리한다.
---

개인 홈 서버에서 첫 번째로 해결할 문제는 Kubernetes가 아니라 일관된 Linux 실행면이다. macOS는 Linux가 아니고, Windows의 일반 파일 경로와 service lifecycle도 Linux server와 다르다. 그래서 호스트마다 자연스러운 VM 기술을 쓰고, VM 안의 상태만 공통 Ansible role로 맞추는 방식을 택했다.

> 실기 검증 범위: macOS Lima는 완료. Windows WSL2/RTX 4060은 구현·정적 검증 완료, 실제 host 검증 전.

## Table of contents

## 설계: 다른 입구, 같은 내부

```text
macOS -- Terraform -- bootstrap-macos.sh -- Lima Ubuntu --+
                                                        +-- Ansible -- k3s
Windows -- PowerShell -- WSL2 Ubuntu -- bootstrap-wsl.sh +
```

Terraform는 호스트별 bootstrap 명령을 구동하는 어댑터에 가깝다. 실제 Ubuntu package와 k3s 상태는 Ansible이 소유한다. 이 경계를 나누면 호스트 차이가 Kubernetes 설정까지 퍼지지 않는다.

## macOS: Lima Ubuntu VM

[Lima 공식 문서](https://lima-vm.io/docs/installation/)에서 안내하는 대로 Homebrew로 설치할 수 있다.

```bash
brew install lima
```

이 구성은 Lima 2.0 이상과 Ubuntu 26.04 template를 고정했다. k3s가 containerd를 제공하므로 Lima의 system/user containerd는 끄고 중복 runtime을 피했다.

```yaml
minimumLimaVersion: 2.0.0

base:
  - template:ubuntu-26.04

containerd:
  system: false
  user: false
```

기본 VM은 6 vCPU, 16 GiB memory, 160 GiB disk다. ClickStack과 Langfuse가 각자 ClickHouse, PostgreSQL, Redis, object storage를 포함하므로 표면상의 최소 k3s 사양보다 넉넉해야 한다.

```bash
limactl start \
  --tty=false \
  --name home-ai-infra \
  --cpus 6 \
  --memory 16 \
  --disk 160 \
  --vm-type vz \
  bootstrap/lima/home-ai-infra.yaml
```

스크립트는 VM을 재사용하고, guest 안에 `ansible-core`를 준비한 뒤 공통 playbook을 적용한다. 마지막에 `/etc/rancher/k3s/k3s.yaml`을 host의 `.state/kubeconfig`로 가져오고 API 주소를 `127.0.0.1:6443`으로 바꾼다.

```bash
make bootstrap PLATFORM=macos
kubectl --kubeconfig .state/kubeconfig get nodes
```

VM에 직접 들어가야 한다면 다음을 쓴다.

```bash
limactl shell home-ai-infra
sudo systemctl status k3s
```

## Windows: WSL2 Ubuntu

신규 Windows에서는 관리자 PowerShell의 `wsl --install`이 공식 기본 경로다. 자동화 스크립트는 WSL과 Virtual Machine Platform optional feature를 켜고, WSL2를 기본으로 지정한 뒤 Ubuntu가 없으면 설치한다.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
./bootstrap/windows/Enable-HomeAiInfra.ps1
```

기본 `.wslconfig`은 20 GiB memory와 6 processor를 할당한다.

```ini
[wsl2]
memory=20GB
processors=6
localhostForwarding=true
```

Windows 11 22H2 이상은 [mirrored networking](https://learn.microsoft.com/windows/wsl/networking)을 추가하고, Windows 10은 NAT와 localhost forwarding을 유지한다.

```ini
networkingMode=mirrored
dnsTunneling=true
firewall=true
```

기존 `.wslconfig`가 있는데 묵묵히 덮어쓰면 사용자의 기존 설정을 잃을 수 있다. 그래서 기본 스크립트는 파일이 있으면 실패하고, 사용자가 직접 merge하거나 `-ForceWslConfig`를 명시하게 했다.

## systemd가 필수인 이유

k3s installer는 Linux service를 만들고 시작한다. 따라서 WSL의 PID 1이 systemd여야 한다. 최신 Ubuntu WSL은 systemd가 기본이지만, 기존 distro는 다를 수 있다.

```bash
ps -p 1 -o comm=
```

`systemd`가 아니라면 [Microsoft의 systemd 절차](https://learn.microsoft.com/windows/wsl/systemd)에 따라 `/etc/wsl.conf`을 설정한다.

```ini
[boot]
systemd=true
```

그런 뒤 PowerShell에서 전체 WSL을 종료하고 다시 연다.

```powershell
wsl --shutdown
```

WSL 안의 Ubuntu에서는 도구를 준비한 후 같은 부트스트랩을 실행한다.

```bash
make doctor PLATFORM=windows
make bootstrap PLATFORM=windows
```

저장소는 `/mnt/c/...`보다 WSL의 Linux filesystem 안에 clone하는 편이 파일 I/O와 permission 일관성 면에서 낫다.

## GPU는 기반만 켜기

Windows 경로는 NVIDIA Container Toolkit과 device plugin을 선택적으로 준비한다. 기본 AI 플랫폼의 smoke가 성공한 뒤에만 켜는 것이 좋다.

```bash
make bootstrap PLATFORM=windows ENABLE_NVIDIA_RUNTIME=true
make gpu
```

`make gpu`는 `nvidia` RuntimeClass와 allocatable GPU를 확인한다. 이 단계는 Ollama나 model workload를 설치하지 않는다. runtime 준비와 모델 선택을 독립적으로 다루어야 문제가 생겼을 때 원인을 좁힐 수 있다.

## 반복 실행 가능성

부트스트랩은 기존 Lima VM이나 k3s service를 재사용한다. 설정을 바꾼 뒤에도 같은 명령으로 선언 상태에 수렴시킨다.

```bash
make bootstrap PLATFORM=macos # or windows
make status
```

VM을 생성했다는 사실보다 더 중요한 것은, 누구나 같은 소스에서 같은 상태로 돌아올 수 있다는 점이다.

## 다음 글

[k3s를 개인 홈 서버에 선언적으로 설치하기](/posts/home-ai-platform-02-k3s)
