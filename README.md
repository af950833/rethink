# rethink - LG ThinQ 로컬 브리지

LG ThinQ 가전과 로컬 네트워크에서 통신하고, 가전 프로토콜을 Home Assistant 호환 MQTT로 변환하는 프로젝트입니다.

이 저장소는 [anszom/rethink](https://github.com/anszom/rethink)를 기반으로 한 Fork입니다. 원작자의 로컬 제어 및 bridge 기능에 다음 기능을 추가했습니다.

- 공유기 DNAT 환경에서 여러 LG 호스트명을 처리하는 SNI별 TLS 인증서
- 기존 ThinQ2 기기를 LG 계정에서 삭제하거나 재등록하지 않는 보존 모드
- 기존 LG 앱, Google Home, Home Assistant 연동을 유지하기 위한 안전장치

> [!WARNING]
> 이 Fork의 추가 기능은 실험적입니다. 실제 가전에 적용하기 전에 테스트 IP와 한 대의 기기로 충분히 검증하세요. LG 계정, 가전 등록, 네트워크 연결에 영향을 줄 수 있으며 어떠한 보증도 제공하지 않습니다.

## 동작 구조

공유기가 지정한 LG 기기의 두 연결만 rethink로 전달합니다.

```text
LG 기기 TCP 443  ──DNAT──> rethink TCP 4433
LG 기기 TCP 8883 ──DNAT──> rethink TCP 8883
```

rethink는 다음 두 역할을 동시에 수행합니다.

1. LG 기기와 로컬로 통신하고 상태 및 명령을 Home Assistant MQTT로 변환합니다.
2. bridge 모드에서 기기 메시지를 실제 LG ThinQ 클라우드로 전달합니다.

이 구성으로 로컬 Home Assistant 제어와 기존 LG 앱·Google Home 사용을 함께 유지하는 것이 목표입니다.

## 이 Fork의 주요 변경사항

### SNI별 TLS 인증서

LG 기기는 모델, 기기 또는 연결 포트에 따라 서로 다른 LG 호스트명을 사용할 수 있습니다. 원본 코드는 `config.hostname`에 맞춘 인증서 하나를 모든 TLS 연결에 사용합니다.

이 Fork는 TLS ClientHello의 SNI를 확인하여 다음과 같이 처리합니다.

1. SNI 호스트명 형식을 검증합니다.
2. 해당 이름이 SAN에 포함된 서버 인증서를 생성합니다.
3. rethink의 CA로 인증서에 서명합니다.
4. 생성한 TLS 컨텍스트를 메모리에 캐시합니다.
5. 임시 개인키와 인증서 파일을 즉시 삭제합니다.

활성화 설정:

```jsonc
"sni_certificates": true
```

CA 개인키는 매우 민감합니다. `ca.key`를 공개 저장소, 로그 또는 백업 공유 공간에 올리지 마세요.

### 기존 ThinQ2 등록 보존

원본 bridge 등록 과정은 기기를 현재 LG Home에서 먼저 삭제하고, “이미 등록됨” 오류가 발생하면 `initDevice: true`로 재시도할 수 있습니다. 이 동작은 기존 LG 앱의 기기, 별칭 및 Google Home 연결을 변경할 수 있습니다.

보존 모드에서는:

- 등록 시작 시 `removeDevice()`를 호출하지 않습니다.
- 현재 LG Home에서 동일한 `deviceId`를 먼저 확인합니다.
- 이미 등록된 기기는 기존 등록과 별칭을 유지합니다.
- “이미 등록됨” 오류가 발생해도 현재 Home에서 동일 기기가 확인된 경우에만 정상 처리합니다.
- 보존 모드에서는 `initDevice: true`로 재시도하지 않습니다.

활성화 설정:

```jsonc
"bridge": {
  "storage_path": "./state",
  "preserve_existing_devices": true
}
```

이 기능은 ThinQ2 전용입니다. ThinQ1 기기는 등록 방식이 다르므로 보존 모드에서 안전하게 거부됩니다.

## 지원 범위

원본 rethink는 에어컨, 냉장고, 세탁기 및 건조기의 일부 모델을 지원합니다. 구체적인 지원 모델과 상태는 [원작자 저장소](https://github.com/anszom/rethink) 및 [프로젝트 Wiki](https://github.com/anszom/rethink/wiki)를 확인하세요.

지원 목록에 없는 기기도 bridge 연결 자체는 가능할 수 있지만, Home Assistant용 MQTT 엔티티 변환은 별도 기기 핸들러가 필요합니다.

## 전체 설치 순서

권장 작업 순서는 다음과 같습니다.

1. rethink 서버와 LG 기기의 IP를 고정합니다.
2. Ubuntu 서버에 저장소를 받고 운영 데이터 폴더를 준비합니다.
3. `config.json`을 작성하고 Docker 이미지를 빌드·실행합니다.
4. rethink 관리 화면에서 LG 계정 로그인과 bridge 설정을 마칩니다.
5. ASUS 공유기에서 한 대의 LG 기기에만 DNAT를 시험 적용합니다.
6. 동작을 확인한 뒤 나머지 기기를 추가합니다.
7. Ubuntu 서버에 DNAT 자동 복구 타이머를 설치합니다.
8. Home Assistant에서 MQTT 엔티티를 확인합니다.

처음부터 여러 기기에 동시에 DNAT를 적용하지 마세요. 한 대로 인증서, bridge 및 Home Assistant 제어가 정상인지 확인한 뒤 범위를 넓히는 것이 안전합니다.

## 1. IP와 포트 계획

rethink 서버와 대상 LG 기기는 DHCP 예약 등으로 IP가 바뀌지 않게 설정해야 합니다. 이 문서에서는 다음 값을 예로 사용합니다.

| 용도 | 예시 |
|---|---|
| ASUS 공유기 | `192.168.0.1` |
| rethink가 실행될 Ubuntu 서버 | `192.168.0.4` |
| 에어컨 | `192.168.0.45` |
| 세탁기 | `192.168.0.17` |
| 냉장고 | `192.168.0.51` |
| rethink 관리 화면 | `http://192.168.0.4:44401/` |
| 기기 HTTPS 전달 | 기기 TCP 443 → 서버 TCP 4433 |
| 기기 MQTTS 전달 | 기기 TCP 8883 → 서버 TCP 8883 |

예시 IP를 그대로 복사하지 말고 반드시 자신의 네트워크에 맞게 바꾸세요.

Ubuntu 서버에서 다음 포트가 다른 프로그램과 충돌하지 않는지도 확인합니다.

```sh
sudo ss -lntp | grep -E ':(4433|8883|44401)\b'
```

## 2. Ubuntu Docker 설치

### 2-1. 저장소 받기

```sh
mkdir -p ~/docker
cd ~/docker
git clone https://github.com/af950833/rethink.git
cd rethink
```

이미 clone했다면:

```sh
cd ~/docker/rethink
git pull --ff-only origin master
```

### 2-2. 운영 데이터 폴더 준비

소스와 인증서·bridge 상태를 분리합니다.

```sh
mkdir -p ~/docker/rethink-data
cp config.jsonc ~/docker/rethink-data/config.json
```

권장 구조:

```text
~/docker/
├── rethink/          # 공개 Git 저장소
└── rethink-data/     # Git에 포함하지 않는 운영 데이터
    ├── config.json   # 사용자가 수정
    ├── ca.key        # 최초 실행 시 자동 생성
    ├── ca.cert       # 최초 실행 시 자동 생성
    └── state/        # bridge 설정 과정에서 자동 생성
```

### 2-3. `config.json` 설정

DNAT 예시에서 TCP 443을 컨테이너의 TCP 4433으로 전달한다면 다음처럼 bind 포트와 기기에 알릴 포트를 나눕니다.

```jsonc
{
    "hostname": "rethink.lan",

    "homeassistant": {
        "mqtt_url": "mqtt://127.0.0.1:1883",
        "discovery_prefix": "homeassistant",
        "rethink_prefix": "rethink",
        "mqtt_user": "YOUR_MQTT_USER",
        "mqtt_pass": "YOUR_MQTT_PASSWORD",
    },

    "ca_key_file": "ca.key",
    "ca_cert_file": "ca.cert",
    "sni_certificates": true,

    "https_port": {
        "bind": 4433,
        "advertise": 443,
    },
    "mqtts_port": 8883,
    "mqtt_port": 1884,
    "management_port": 44401,

    "bridge": {
        "storage_path": "./state",
        "preserve_existing_devices": true,
    },

    "log": ["status", "incoming", "HTTPS", "publish", "MGMT"],
}
```

실제 MQTT 계정과 비밀번호가 들어간 `config.json`은 Git에 commit하지 마세요.

### 2-4. 이미지 빌드

```sh
cd ~/docker/rethink
docker build --pull -t rethink-lg-bridge:local .
```

### 2-5. 컨테이너 실행

```sh
docker run -d \
  --name rethink \
  --restart unless-stopped \
  --network host \
  -v "$HOME/docker/rethink-data:/app/data" \
  rethink-lg-bridge:local
```

`--network host`를 사용하므로 별도의 `-p` 포트 매핑은 필요하지 않습니다.

실행 상태와 로그를 확인합니다.

```sh
docker ps --filter name=rethink
docker logs -f rethink
```

`ca.key`와 `ca.cert`는 이미지 빌드 시가 아니라 컨테이너 최초 실행 시 `/app/data`에 자동 생성됩니다. 같은 데이터 폴더를 계속 연결하면 이미지와 컨테이너를 교체해도 기존 CA와 bridge 상태가 유지됩니다.

## 3. rethink 초기 설정

브라우저에서 다음 주소를 엽니다.

```text
http://RETHINK_SERVER_IP:44401/
```

예:

```text
http://192.168.0.4:44401/
```

관리 화면이 열리지 않으면 먼저 컨테이너 상태와 로그를 확인합니다.

```sh
docker ps --filter name=rethink
docker logs --tail 200 rethink
```

컨테이너 상태가 계속 `Restarting`이면 DNAT를 적용하지 말고 `config.json` 문법, 포트 충돌 및 데이터 폴더 권한부터 해결하세요.

관리 화면에서 LG 계정에 로그인하고 국가 코드를 `KR`로 설정한 뒤 bridge 구성을 완료합니다. 기존 LG 앱 등록을 유지하려면 `preserve_existing_devices`가 `true`인지 다시 확인하세요. DNAT 적용 전에는 연결 기기가 보이지 않는 것이 정상일 수 있습니다.

## 4. ASUS 공유기 최초 설정

다음 절차는 ASUSWRT 순정 펌웨어 기준입니다. 펌웨어 버전에 따라 메뉴 이름이 조금 다를 수 있습니다.

### 4-1. SSH를 LAN 전용으로 활성화

1. ASUS 공유기 Web GUI에 로그인합니다.
2. **Administration(관리) → System(시스템) → Service(서비스)**로 이동합니다.
3. **Enable SSH(SSH 사용)**를 **LAN only(LAN 전용)**로 설정합니다.
4. SSH 포트를 확인하고 설정을 적용합니다.
5. Ubuntu 서버에서 공유기에 한 번 직접 접속해 호스트 키를 확인하고 저장합니다.

```sh
ssh ROUTER_ADMIN@192.168.0.1
```

WAN에서도 SSH를 허용하지 마세요. ASUS 공식 안내에도 SSH를 `LAN only` 또는 `LAN & WAN`으로 선택하는 절차가 설명되어 있으며, 이 구성에서는 반드시 LAN 전용을 권장합니다.

공식 참고 문서: [ASUS 공유기 SSH 활성화 안내](https://www.asus.com/global/support/faq/1048201/)

### 4-2. 기존 NAT 규칙 확인

공유기에 SSH로 접속한 뒤 현재 규칙을 먼저 확인하고 별도로 보관합니다.

```sh
/usr/sbin/iptables -t nat -S PREROUTING
```

다음 명령은 이 프로젝트에서 절대로 사용하지 마세요.

```text
iptables -t nat -F
iptables -t nat -X
iptables-restore
```

위 명령은 ASUS가 만든 포트 포워딩, 게임 가속 및 기타 NAT 체인에 영향을 줄 수 있습니다. rethink 구성은 `PREROUTING`에 출발지 IP가 정확히 일치하는 규칙 두 개만 추가합니다.

### 4-3. 한 대에 DNAT 시험 적용

아래 예시는 IP가 `192.168.0.45`인 에어컨만 rethink 서버 `192.168.0.4`로 전달합니다. 공유기 SSH 화면에서 실행합니다.

```sh
LG_IP=192.168.0.45
RETHINK_IP=192.168.0.4

/usr/sbin/iptables -t nat -C PREROUTING -s "$LG_IP" -p tcp --dport 443 -j DNAT --to-destination "$RETHINK_IP:4433" 2>/dev/null ||
  /usr/sbin/iptables -t nat -I PREROUTING 1 -s "$LG_IP" -p tcp --dport 443 -j DNAT --to-destination "$RETHINK_IP:4433"

/usr/sbin/iptables -t nat -C PREROUTING -s "$LG_IP" -p tcp --dport 8883 -j DNAT --to-destination "$RETHINK_IP:8883" 2>/dev/null ||
  /usr/sbin/iptables -t nat -I PREROUTING 1 -s "$LG_IP" -p tcp --dport 8883 -j DNAT --to-destination "$RETHINK_IP:8883"
```

`-C`로 동일 규칙이 있는지 먼저 검사하므로 같은 블록을 다시 실행해도 중복 규칙이 생기지 않습니다. 기존 ASUS 규칙의 삭제나 순서 변경도 하지 않습니다.

### 4-4. 기존 연결 기록 정리

DNAT 규칙을 처음 추가했어도 이미 연결된 443/8883 세션은 이전 인터넷 경로를 계속 사용할 수 있습니다. 대상 기기와 두 포트로 범위를 제한해 기존 연결만 삭제합니다.

```sh
/usr/sbin/conntrack -D -s "$LG_IP" -p tcp --dport 443 2>/dev/null || true
/usr/sbin/conntrack -D -s "$LG_IP" -p tcp --dport 8883 2>/dev/null || true
```

공유기에 `conntrack`이 있는지 확인하려면 다음을 실행합니다.

```sh
which conntrack
/usr/sbin/conntrack -V
```

전체 conntrack 테이블을 비우면 다른 기기의 통신까지 끊길 수 있으므로 사용하지 마세요.

### 4-5. 적용 결과 확인

```sh
/usr/sbin/iptables -t nat -S PREROUTING
/usr/sbin/iptables -t nat -L PREROUTING -n -v --line-numbers
/usr/sbin/conntrack -L -s "$LG_IP"
```

그다음 Ubuntu 서버에서 rethink 로그를 확인합니다.

```sh
docker logs -f rethink
```

관리 화면의 Connected devices에 기기가 나타나고 bridge 연결 및 LG 앱 사용이 모두 정상인지 확인합니다. 문제가 없다면 `LG_IP`만 바꿔 세탁기, 냉장고 등 다른 기기에 같은 절차를 반복합니다.

## 5. ASUS DNAT 자동 복구

ASUS 순정 펌웨어는 공유기 재부팅이나 방화벽 재시작 때 수동으로 추가한 규칙이 사라질 수 있습니다. 순정 펌웨어에서는 사용자 방화벽 훅 실행이 보장되지 않으므로, 항상 켜져 있는 Ubuntu 서버가 1분마다 SSH로 규칙을 확인하는 방식을 권장합니다.

### 5-1. Ubuntu 서버에서 SSH 키 준비

자동 복구에 공유기 관리자 비밀번호를 파일로 저장하지 마세요. Ubuntu 서버에서 전용 SSH 키를 만들고 공개키를 공유기에 등록합니다.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/asus-rethink -C asus-rethink-dnat
ssh-copy-id -i ~/.ssh/asus-rethink.pub ROUTER_ADMIN@192.168.0.1
ssh -i ~/.ssh/asus-rethink ROUTER_ADMIN@192.168.0.1
```

일부 ASUS 순정 펌웨어는 `ssh-copy-id` 또는 공개키 영구 저장을 지원하지 않을 수 있습니다. 이 경우 펌웨어가 제공하는 **Authorized Keys** 입력란에 `asus-rethink.pub` 내용을 등록하세요. 공개키를 영구 등록할 방법이 없다면 아래 자동 복구를 사용하지 말고 재부팅 후 수동으로 4-3과 4-4를 실행하세요.

### 5-2. 자동 복구 스크립트 작성

Ubuntu 서버에서 `/usr/local/sbin/lg-rethink-dnat` 파일을 다음 내용으로 만듭니다. `ROUTER_USER`, `ROUTER_IP`, `RETHINK_IP`, `LG_IPS`를 자신의 환경에 맞게 수정하세요.

```sh
sudo tee /usr/local/sbin/lg-rethink-dnat >/dev/null <<'SCRIPT'
#!/bin/sh
set -eu

ROUTER_USER='ROUTER_ADMIN'
ROUTER_IP='192.168.0.1'
RETHINK_IP='192.168.0.4'
LG_IPS='192.168.0.45 192.168.0.17 192.168.0.51'
SSH_KEY='/home/YOUR_UBUNTU_USER/.ssh/asus-rethink'

for LG_IP in $LG_IPS; do
  ssh -i "$SSH_KEY" \
    -o BatchMode=yes \
    -o ConnectTimeout=5 \
    "$ROUTER_USER@$ROUTER_IP" \
    "LG_IP='$LG_IP' RETHINK_IP='$RETHINK_IP' sh -s" <<'REMOTE'
changed=0

/usr/sbin/iptables -t nat -C PREROUTING -s "$LG_IP" -p tcp --dport 443 \
  -j DNAT --to-destination "$RETHINK_IP:4433" 2>/dev/null ||
{
  /usr/sbin/iptables -t nat -I PREROUTING 1 -s "$LG_IP" -p tcp --dport 443 \
    -j DNAT --to-destination "$RETHINK_IP:4433"
  changed=1
}

/usr/sbin/iptables -t nat -C PREROUTING -s "$LG_IP" -p tcp --dport 8883 \
  -j DNAT --to-destination "$RETHINK_IP:8883" 2>/dev/null ||
{
  /usr/sbin/iptables -t nat -I PREROUTING 1 -s "$LG_IP" -p tcp --dport 8883 \
    -j DNAT --to-destination "$RETHINK_IP:8883"
  changed=1
}

if [ "$changed" -eq 1 ] && [ -x /usr/sbin/conntrack ]; then
  /usr/sbin/conntrack -D -s "$LG_IP" -p tcp --dport 443 2>/dev/null || true
  /usr/sbin/conntrack -D -s "$LG_IP" -p tcp --dport 8883 2>/dev/null || true
fi
REMOTE
done
SCRIPT

sudo chmod 755 /usr/local/sbin/lg-rethink-dnat
```

이 스크립트는 다음 원칙으로 동작합니다.

- 정확히 같은 규칙이 있으면 아무것도 추가하지 않습니다.
- 없어진 rethink 규칙만 `PREROUTING` 앞쪽에 추가합니다.
- ASUS가 만든 다른 NAT 규칙이나 체인은 조회 외에는 건드리지 않습니다.
- 하나 이상의 규칙을 실제로 복구했을 때만 해당 LG 기기의 443/8883 conntrack을 삭제합니다.
- 전체 방화벽이나 전체 conntrack을 초기화하지 않습니다.

타이머 등록 전에 직접 한 번 실행하고 공유기 규칙을 확인합니다.

```sh
sudo /usr/local/sbin/lg-rethink-dnat
ssh -i ~/.ssh/asus-rethink ROUTER_ADMIN@192.168.0.1 \
  '/usr/sbin/iptables -t nat -S PREROUTING'
```

### 5-3. systemd 타이머 등록

```sh
sudo tee /etc/systemd/system/lg-rethink-dnat.service >/dev/null <<'UNIT'
[Unit]
Description=Restore LG rethink DNAT rules on ASUS router
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=YOUR_UBUNTU_USER
ExecStart=/usr/local/sbin/lg-rethink-dnat
UNIT

sudo tee /etc/systemd/system/lg-rethink-dnat.timer >/dev/null <<'UNIT'
[Unit]
Description=Check LG rethink DNAT rules every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
RandomizedDelaySec=5s
Persistent=true
Unit=lg-rethink-dnat.service

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now lg-rethink-dnat.timer
```

상태와 최근 실행 로그를 확인합니다.

```sh
systemctl status lg-rethink-dnat.timer
systemctl list-timers lg-rethink-dnat.timer
journalctl -u lg-rethink-dnat.service --since today
```

공유기 방화벽을 일부러 재시작해 시험하지 마세요. 다음 자연스러운 공유기 재부팅 후 규칙이 1분 안에 중복 없이 복구되는지 확인하면 됩니다.

## 6. Home Assistant 확인

rethink는 MQTT Discovery를 사용합니다. `config.json`의 MQTT 주소, ID/PW 및 `discovery_prefix`가 Home Assistant의 MQTT 브로커 설정과 일치해야 합니다.

1. rethink 로그에서 MQTT 연결 오류가 없는지 확인합니다.
2. Home Assistant의 **설정 → 기기 및 서비스 → MQTT**에서 LG 기기를 확인합니다.
3. 엔티티가 비활성화되어 있으면 해당 MQTT 기기 페이지에서 필요한 엔티티를 활성화합니다.
4. 상태 확인부터 하고 전원, 모드, 온도 같은 제어는 한 항목씩 시험합니다.
5. LG ThinQ 앱에서도 같은 기기의 상태와 제어가 정상인지 확인합니다.

지원 목록에 없는 모델은 Connected devices에 나타나고 bridge가 동작해도 Home Assistant 엔티티가 일부만 생성되거나 제어가 동작하지 않을 수 있습니다. 이런 경우 모델별 핸들러 추가가 필요합니다.

## 7. 업데이트

```sh
cd ~/docker/rethink
git pull --ff-only origin master
docker build --pull -t rethink-lg-bridge:local .

docker stop rethink
docker rm rethink

docker run -d \
  --name rethink \
  --restart unless-stopped \
  --network host \
  -v "$HOME/docker/rethink-data:/app/data" \
  rethink-lg-bridge:local
```

업데이트 전 `~/docker/rethink-data`를 백업하는 것을 권장합니다.

`docker stop`과 `docker rm`은 컨테이너만 제거합니다. 위 명령은 호스트의 `~/docker/rethink-data`를 삭제하지 않으므로 기존 `config.json`, CA 및 bridge 상태가 그대로 유지됩니다.

## 8. 운영 전 최종 확인

다음 조건을 모두 확인한 뒤 실제 기기 IP에 DNAT를 적용하세요.

- rethink가 TCP 4433과 8883에서 정상적으로 대기 중
- Home Assistant MQTT 연결 정상
- rethink bridge 로그인 및 기기 인증서 발급 정상
- rethink 서버와 각 LG 기기의 DHCP 고정 IP 설정 완료
- 공유기 DNAT 규칙이 지정한 LG 기기의 TCP 443·8883에만 적용됨
- SNI별 인증서 생성 오류가 로그에 없음

가능하면 미사용 테스트 IP로 DNAT 명령을 먼저 검증하세요.

## 9. 필수 원복 순서

원복 순서는 반드시 다음과 같아야 합니다.

1. rethink에서 해당 기기의 bridge를 비활성화합니다.
2. bridge 연결이 종료된 것을 로그에서 확인합니다.
3. 자동 복구 대상에서 해당 IP를 제거합니다. 전체 구성을 중단한다면 타이머를 정지합니다.
4. 공유기에서 정확히 일치하는 DNAT 규칙만 제거합니다.
5. 해당 기기의 443/8883 conntrack만 삭제하거나 자연스러운 재접속을 기다립니다.

자동 복구 전체를 중지하려면 Ubuntu 서버에서 다음을 실행합니다.

```sh
sudo systemctl disable --now lg-rethink-dnat.timer
```

공유기에서 기기 한 대의 규칙만 제거하는 예:

```sh
LG_IP=192.168.0.45
RETHINK_IP=192.168.0.4

/usr/sbin/iptables -t nat -C PREROUTING -s "$LG_IP" -p tcp --dport 443 -j DNAT --to-destination "$RETHINK_IP:4433" 2>/dev/null &&
  /usr/sbin/iptables -t nat -D PREROUTING -s "$LG_IP" -p tcp --dport 443 -j DNAT --to-destination "$RETHINK_IP:4433"

/usr/sbin/iptables -t nat -C PREROUTING -s "$LG_IP" -p tcp --dport 8883 -j DNAT --to-destination "$RETHINK_IP:8883" 2>/dev/null &&
  /usr/sbin/iptables -t nat -D PREROUTING -s "$LG_IP" -p tcp --dport 8883 -j DNAT --to-destination "$RETHINK_IP:8883"

/usr/sbin/conntrack -D -s "$LG_IP" -p tcp --dport 443 2>/dev/null || true
/usr/sbin/conntrack -D -s "$LG_IP" -p tcp --dport 8883 2>/dev/null || true
```

bridge를 켜 둔 채 DNAT만 제거하면 rethink와 실제 가전이 같은 MQTT client ID로 LG 클라우드에 접속하면서 서로 연결을 끊을 수 있습니다.

## 운영 데이터와 보안

다음 항목은 공개 Git 저장소에 올리지 마세요.

```text
config.json
.env
ca.key
ca.cert
state/
data/
*.pem
*.key
*.crt
*.p12
*.pfx
```

특히 `state/`에는 LG bridge 연결에 사용하는 기기 인증서와 개인키가 포함될 수 있습니다.

컨테이너를 다시 만들 때도 항상 동일한 `-v "$HOME/docker/rethink-data:/app/data"` 옵션을 사용하세요. 호스트의 `~/docker/rethink-data` 폴더를 삭제하면 CA 및 bridge 상태를 잃을 수 있습니다.

## 관리 화면과 도구

기본 관리 화면 포트는 TCP 44401입니다. 관리 화면에서는 다음 기능을 제공합니다.

- rethink에 연결된 기기 목록 확인
- 통신 모니터링 및 패킷 주입
- bridge 설정

주요 도구:

- [`rethink-setup`](rethink-setup.ts): 공식 앱 없이 초기 Wi-Fi 설정 수행
- [`rethink-cloud`](rethink-cloud.ts): ThinQ 클라우드 대체 서버 및 MQTT 변환
- [`packet-parser`](tools/packet-parser.ts): MQTT의 TLV 패킷 해석
- [`packet-sender`](tools/packet-sender.ts): 가전으로 보낼 TLV 패킷 생성
- [`rethink-capture`](tools/rethink-capture.ts): 기기 통신 캡처
- [`lgcloud-monitor`](tools/lgcloud-monitor.ts): 공식 LG 클라우드 알림 모니터링

## 문제 해결

### MQTT 8883 연결에서 인증서 오류

- `sni_certificates`가 `true`인지 확인합니다.
- OpenSSL이 컨테이너에 설치되어 있는지 확인합니다.
- 로그에서 `Invalid TLS SNI hostname` 또는 `openssl failed`를 찾습니다.
- `ca.key`와 `ca.cert`를 임의로 교체하거나 삭제하지 마세요.

### LG 앱에서 기기가 사라지거나 이름이 변경됨

- `preserve_existing_devices`가 `true`인지 확인합니다.
- ThinQ1 기기가 아닌지 확인합니다.
- 기존 등록을 보존하기 전에 원본 rethink로 재등록하지 않았는지 확인합니다.

### DNAT를 적용했지만 rethink로 전환되지 않음

- 기기의 고정 IP와 DNAT 출발지 IP가 같은지 확인합니다.
- 기존 연결이 conntrack에 남아 있을 수 있으므로 재접속을 기다립니다.
- 공유기에서 DNAT 패킷 카운터가 증가하는지 확인합니다.

### bridge와 실제 기기가 반복적으로 재접속

동일한 MQTT client ID 충돌 가능성이 큽니다. bridge를 먼저 비활성화한 뒤 DNAT를 제거하세요.

## 원작자 및 라이선스

- 원본 프로젝트: [anszom/rethink](https://github.com/anszom/rethink)
- 이 Fork: [af950833/rethink](https://github.com/af950833/rethink)
- 라이선스: [GNU General Public License v2.0](COPYING)

LG ThinQ 명칭은 식별 목적으로만 사용합니다. 이 프로젝트와 Fork는 LG전자와 제휴하거나 공식적으로 지원받는 프로젝트가 아닙니다.

이 프로그램은 상품성 또는 특정 목적 적합성에 대한 어떠한 보증도 없이 제공됩니다. 사용으로 인해 발생하는 기기, 계정 또는 네트워크 문제는 사용자가 직접 복구해야 합니다.
