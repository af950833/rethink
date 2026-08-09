# rethink - LG ThinQ 로컬 브리지

LG ThinQ 가전과 로컬 네트워크에서 통신하고, 가전 프로토콜을 Home Assistant 호환 MQTT로 변환하는 프로젝트입니다.

이 저장소는 [anszom/rethink](https://github.com/anszom/rethink)를 기반으로 한 Fork입니다. 원작자의 로컬 제어 및 bridge 기능에 다음 기능을 추가했습니다.

- 공유기 DNAT 환경에서 여러 LG 호스트명을 처리하는 SNI별 TLS 인증서
- 기존 ThinQ2 기기의 LG ThinQ Home 등록과 별칭을 다시 만들지 않는 보존 모드
- bridge를 사용하는 동안 기존 LG 앱, Google Home, Home Assistant 연동을 유지하기 위한 안전장치
- ThinQ2 클라우드 ACK를 원본 JSON 그대로 기기에 전달하는 브리지 수정
- ASUS 공유기의 DNAT 규칙과 conntrack을 SSH로 관리하는 웹 화면

> [!WARNING]
> 이 Fork의 추가 기능은 실험적입니다. 실제 가전에 적용하기 전에 테스트 IP와 한 대의 기기로 충분히 검증하세요. LG 계정, 가전 등록, 네트워크 연결에 영향을 줄 수 있으며 어떠한 보증도 제공하지 않습니다.
>
> `bridge.preserve_existing_devices: true`는 bridge 활성화 과정에서 기존 LG ThinQ Home 등록, 기기 별칭 및 외부 연동을 삭제하거나 다시 만들지 않도록 보호합니다. 원래 기기가 LG 클라우드에 직접 접속할 때 사용하는 인증 자격까지 보존하는 옵션은 아닙니다.
>
> `PAC_910604_WW`에서 확인한 결과, Rethink용 bridge 인증서가 발급된 후에는 bridge를 끄고 DNAT를 제거하더라도 원래 기기가 LG 클라우드에 직접 복귀하지 못했습니다. Rethink를 완전히 해제하려면 LG ThinQ 앱에서 해당 기기의 Wi-Fi 등록을 다시 진행해야 합니다. 다른 ThinQ2 모델에서도 같은 현상이 발생할 수 있습니다.

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

원본 제작자의 bridge 방식은 로컬 bridge 연결을 등록하는 과정에서 기기를 현재 LG ThinQ Home에서 해제한 뒤 다시 등록해야 할 수 있습니다. 또한 기기가 이미 등록되어 있다는 응답을 받으면 초기화 옵션을 사용해 재등록을 시도해야 합니다. 이 과정에서 LG ThinQ 앱의 기기 등록과 별칭 또는 Google Home 같은 기존 연동이 변경됩니다.

이 저장소의 수정된 보존 모드에서는:

- 등록 시작 시 `removeDevice()`를 호출하지 않습니다.
- 현재 LG Home에서 동일한 `deviceId`를 먼저 확인합니다.
- 이미 등록된 기기는 기존 등록과 별칭을 유지합니다.
- “이미 등록됨” 오류가 발생해도 현재 Home에서 동일 기기가 확인된 경우에만 정상 처리합니다.
- 보존 모드에서는 `initDevice: true`로 재시도하지 않습니다.

이 기능이 보존하는 대상은 **LG ThinQ Home의 기존 기기 등록과 별칭**입니다. Rethink가 LG 클라우드에 접속하기 위한 별도 bridge 인증서를 발급받은 뒤에도 원래 기기의 클라우드 직접 접속 인증 자격이 유지된다는 의미는 아닙니다. 따라서 보존 모드를 사용하더라도 Rethink를 완전히 제거하여 직접 연결로 돌아갈 때는 기기의 ThinQ Wi-Fi 재등록이 필요할 수 있습니다.

활성화 설정:

```jsonc
"bridge": {
  "storage_path": "./state",
  "preserve_existing_devices": true
}
```

이 기능은 ThinQ2 전용입니다. ThinQ1 기기는 등록 방식이 다르므로 보존 모드에서 안전하게 거부됩니다.

### ThinQ2 클라우드 ACK 전달

원본 bridge는 LG 클라우드에서 받은 메시지 중 `cmd: "packet"`만 실제 기기로 전달하고 `cmd: "ack"`는 처리하지 않습니다. ACK를 요구하는 기기는 클라우드가 정상적으로 응답해도 이를 받지 못해 동일한 상태·집계 패킷을 여러 번 다시 보낼 수 있습니다. 반복된 보고가 클라우드에서 각각 처리되면 에너지 사용량 같은 통계가 실제보다 크게 집계될 가능성도 있습니다.

이 Fork는 클라우드에서 받은 `packet`과 `ack`를 모두 실제 기기로 전달합니다. 이때 새 JSON을 만들지 않고 클라우드 응답의 `mid`, `cmd`, `type`, `data`를 그대로 유지합니다.

```text
LG 기기 → rethink → LG 클라우드
                        │
                        └─ cmd: "ack"
                               ↓
LG 기기 ← rethink ← LG 클라우드
```

실제 `2RES2VE300UA2` 냉장고에서 ACK가 누락될 때 동일 패킷이 반복 전송되는 현상과, ACK 전달 후 한 번의 전송으로 종료되는 것을 확인했습니다. 이 수정은 냉장고 모델 핸들러가 아니라 ThinQ2 bridge 공통 계층에 적용되므로 같은 ACK 방식을 사용하는 다른 ThinQ2 기기에도 적용됩니다.

## 지원 범위

원본 rethink는 에어컨, 냉장고, 세탁기 및 건조기의 일부 모델을 지원합니다. 구체적인 지원 모델과 상태는 [원작자 저장소](https://github.com/anszom/rethink) 및 [프로젝트 Wiki](https://github.com/anszom/rethink/wiki)를 확인하세요.

지원 목록에 없는 기기도 bridge 연결 자체는 가능할 수 있지만, Home Assistant용 MQTT 엔티티 변환은 별도 기기 핸들러가 필요합니다.

이 Fork에는 실제 기기 통신을 확인하여 다음 세 모델의 핸들러를 추가·보완했습니다.

| 기기      | 모델 코드와 핸들러 | 추가된 주요 기능                                                                                                          |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| LG 에어컨 | `PAC_910604_WW`    | 냉방·제습·송풍, 풍량, 쿨파워·롱파워, 수평·수직 회전, 절전 및 부가 설정                                                    |
| LG 세탁기 | `Hd0C_F`           | 운전 상태와 남은 시간, 세탁통 청소 횟수, 원격 시작 가능 상태, 시작·일시정지·전원 끄기                                     |
| LG 냉장고 | `2RES2VE300UA2`    | 냉장·냉동 목표 온도 climate, 특급 냉장·냉동, 문 상태, 필터, 오늘 문 열림 횟수·누적 시간·60초 경고, 시간·일·월 전력 사용량 |

같은 종류의 제품이라도 모델 프로토콜이 다르면 위 핸들러가 적용되지 않을 수 있습니다. 관리 화면에 연결된 모델 코드가 표의 모델과 다르거나 MQTT 엔티티가 생성되지 않으면 별도 패킷 확인과 핸들러 추가가 필요합니다.

냉장고 전력 센서는 기기가 15분마다 보내는 `10AF` 구간 사용량(Wh)을 한국 시간 기준으로 합산합니다. 실제 기기에서 확인된 구분 바이트 `0F`와 `10` 형식을 모두 처리합니다. 같은 15분 슬롯에서 재전송된 패킷은 한 번만 반영하며, 누적값은 `/app/data`에 저장됩니다. 시간·일·월 센서는 각 기간 경계에서 초기화되고, 최초 설치 전에 사용한 과거 전력량은 자동으로 복원하지 않습니다.

## 전체 설치 순서

권장 작업 순서는 다음과 같습니다.

1. rethink 서버와 LG 기기의 IP를 고정합니다.
2. Ubuntu 서버에 저장소를 받고 운영 데이터 폴더를 준비합니다.
3. `config.json`을 작성하고 Docker 이미지를 빌드·실행합니다.
4. rethink 관리 화면에서 LG 계정 로그인을 마칩니다.
5. DNAT 관리 화면에 공유기 SSH 정보를 저장하고 한 대의 LG 기기에만 DNAT를 시험 적용합니다.
6. 감지된 기기를 등록한 IP에 연결한 뒤 Bridge를 켭니다.
7. 동작을 확인한 뒤 나머지 기기를 추가합니다.
8. Home Assistant에서 MQTT 엔티티를 확인합니다.

처음부터 여러 기기에 동시에 DNAT를 적용하지 마세요. 한 대로 인증서, bridge 및 Home Assistant 제어가 정상인지 확인한 뒤 범위를 넓히는 것이 안전합니다.

## 1. IP와 포트 계획

rethink 서버와 대상 LG 기기는 DHCP 예약 등으로 IP가 바뀌지 않게 설정해야 합니다. 이 문서에서는 다음 값을 예로 사용합니다.

| 용도                         | 예시                          |
| ---------------------------- | ----------------------------- |
| ASUS 공유기                  | `192.168.0.1`                 |
| rethink가 실행될 Ubuntu 서버 | `192.168.0.4`                 |
| 에어컨                       | `192.168.0.45`                |
| 세탁기                       | `192.168.0.17`                |
| 냉장고                       | `192.168.0.51`                |
| rethink 관리 화면            | `http://192.168.0.4:44401/`   |
| 기기 HTTPS 전달              | 기기 TCP 443 → 서버 TCP 4433  |
| 기기 MQTTS 전달              | 기기 TCP 8883 → 서버 TCP 8883 |

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
    ├── router-dnat.json # DNAT 관리 화면의 공유기 및 기기 설정
    └── state/        # bridge 설정 과정에서 자동 생성
```

### 2-3. `config.json` 설정

운영 설정 파일을 다음 명령으로 엽니다.

```sh
nano ~/docker/rethink-data/config.json
```

수정을 마치면 `Ctrl+O`, `Enter`로 저장하고 `Ctrl+X`로 nano를 종료합니다.

최소한 다음 항목을 자신의 환경에 맞게 수정합니다.

- `homeassistant.mqtt_url`: MQTT 브로커 주소와 포트. 같은 Ubuntu 서버의 1883 포트를 사용하면 `mqtt://127.0.0.1:1883`
- `homeassistant.mqtt_user`, `homeassistant.mqtt_pass`: MQTT 접속 ID와 비밀번호
- `https_port.bind`: rethink가 실제로 대기할 HTTPS 포트. 이 안내에서는 `4433`
- `https_port.advertise`: LG 기기에 안내할 원래 HTTPS 포트. `443`
- `management_port`: 웹 관리 화면 포트. 이 안내에서는 `44401`
- `bridge.storage_path`: 인증서와 bridge 상태를 보관할 위치. 데이터 폴더 내부의 `./state`
- `bridge.preserve_existing_devices`: bridge 사용 중 기존 LG ThinQ Home 등록과 별칭을 유지하려면 `true`. 이 옵션은 완전 원복 시 Wi-Fi 재등록을 생략하게 해 주는 옵션이 아닙니다.

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
  --log-opt max-size=10m \
  --log-opt max-file=3 \
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

bridge 사용 중 기존 LG ThinQ Home의 기기 등록과 별칭을 유지하려면 DNAT를 적용하기 전에 `~/docker/rethink-data/config.json`의 `bridge.preserve_existing_devices`가 `true`인지 확인하세요. 이 설정은 원래 기기의 클라우드 직접 접속 인증 자격까지 보존하지는 않습니다.

관리 화면에서 bridge 로그인은 다음 순서로 진행합니다.

1. 국가 코드 입력란에 대문자로 `KR`을 입력합니다.
2. LG 계정 로그인 버튼을 누릅니다.
3. 새로 열린 LG 로그인 창에서 기존 ThinQ 앱에 사용하는 LG 계정으로 로그인합니다.
4. 로그인과 약관 동의를 마치면 브라우저가 완료 또는 빈 화면으로 이동할 수 있습니다. 이때 로그인 창의 **주소 표시줄에 있는 URL 전체를 복사**합니다.
5. rethink 관리 화면으로 돌아와 URL 입력란에 복사한 주소를 그대로 붙여넣습니다.
6. 확인 또는 제출 버튼을 눌러 인증을 완료합니다.

URL의 일부만 복사하거나 로그인 전 주소를 붙여넣으면 인증이 완료되지 않습니다. 로그인 완료 후 마지막으로 표시된 URL 전체를 `https://`부터 끝까지 복사하세요. LG 계정 비밀번호를 rethink의 URL 입력란에 직접 입력하는 것은 아닙니다.

DNAT 적용 전에는 Connected devices에 기기가 보이지 않는 것이 정상일 수 있습니다.

## 4. ASUS Router DNAT Management

다음 절차는 `iptables`와 `conntrack`이 포함된 ASUSWRT 순정 펌웨어를 기준으로 합니다. 이 Fork는 관리 화면에서 공유기에 SSH로 접속하여 기기별 DNAT 상태를 조회하고 적용·해제할 수 있습니다. 공유기 전체 NAT 테이블을 초기화하지 않으며, 관리 대상 IP의 TCP 443과 8883 규칙만 다룹니다.

### 4-1. 공유기 SSH 준비

ASUS 공유기 Web GUI에서 SSH를 **LAN only(LAN 전용)**로 활성화합니다. WAN SSH는 허용하지 마세요. PC에서 다음 명령으로 로그인이 되는지 먼저 확인합니다.

```sh
ssh ROUTER_ADMIN@192.168.0.1
```

공유기에서 다음 두 도구도 확인합니다.

```sh
/usr/sbin/iptables --version
/usr/sbin/conntrack -V
```

공식 참고 문서: [ASUS 공유기 SSH 활성화 안내](https://www.asus.com/global/support/faq/1048201/)

### 4-2. DNAT 관리 화면 열기

기본 Rethink 관리 화면 오른쪽 위의 **Asus Router DNAT Management**를 누르거나 다음 주소를 직접 엽니다.

```text
http://RETHINK_SERVER_IP:44401/router.html
```

페이지 상단의 **Router SSH settings**에 다음 값을 입력합니다.

| 항목 | 설명 |
| --- | --- |
| Router IP | ASUS 공유기의 LAN IP. 예: `192.168.0.1` |
| SSH Port | 공유기 SSH 포트. 기본값은 `22` |
| Username | ASUS 공유기 관리자 계정 |
| Password | 공유기 SSH 암호. 눈 모양 버튼은 새로 입력한 값만 표시·숨김 |
| Rethink IP | rethink 컨테이너가 host network로 사용하는 Ubuntu 서버 IP. 예: `192.168.0.4` |

**Test connection**으로 `iptables`와 `conntrack` 실행 가능 여부를 확인한 다음 **Save**를 누릅니다. 암호 입력란이 비어 있으면 이전에 저장한 암호를 유지합니다. 저장된 암호를 웹 화면으로 다시 보내지는 않습니다.

설정은 컨테이너의 `/app/data/router-dnat.json`, 호스트의 `~/docker/rethink-data/router-dnat.json`에 저장되며 파일 권한은 `600`입니다. 이 파일은 암호를 포함하므로 Git에 추가하거나 외부에 공유하지 마세요.

### 4-3. 한 대의 기기 IP 등록

처음에는 DNAT 목록이 비어 있습니다. **Add device**를 누르고 시험할 LG 기기의 고정 IP만 입력합니다. 이름은 입력하지 않습니다. 이 문서의 에어컨 예시는 `192.168.0.45`입니다.

등록 직후에는 다음처럼 표시됩니다.

- Name: `-`
- IP: 사용자가 입력한 실제 LG 기기 IP
- Device: `Waiting for connection` 또는 감지된 기기 선택 목록
- DNAT: `Off`
- Bridge: 기기 연결 전에는 `Disabled`

### 4-4. DNAT 켜기

등록한 행의 **DNAT** 스위치를 `On`으로 바꿉니다. 관리 기능은 다음 작업을 순서대로 수행합니다.

1. `RETHINK_DNAT` 전용 NAT 체인이 없으면 생성합니다.
2. `PREROUTING`에서 전용 체인으로 들어가는 jump 규칙이 없으면 한 번만 추가합니다.
3. 해당 기기의 TCP 443을 rethink TCP 4433으로 전달합니다.
4. 해당 기기의 TCP 8883을 rethink TCP 8883으로 전달합니다.
5. 같은 규칙이 이미 있으면 중복으로 추가하지 않습니다.
6. 해당 기기 IP의 TCP 443·8883 conntrack만 삭제하여 새 경로로 재접속시킵니다.
7. 두 규칙을 다시 조회하여 모두 존재할 때만 `On`으로 표시합니다.

ASUS의 `GAME_VSERVER`, `VSERVER`, 포트 포워딩 및 다른 기기의 NAT 규칙은 변경하거나 초기화하지 않습니다. 다음 명령은 절대로 사용하지 마세요.

```text
iptables -t nat -F
iptables -t nat -X
iptables-restore
```

### 4-5. 공유기에서 규칙 확인

관리 화면으로 추가한 개별 규칙은 `PREROUTING`에 직접 표시되지 않고 `RETHINK_DNAT` 전용 체인에 들어갑니다.

```sh
/usr/sbin/iptables -t nat -S PREROUTING
/usr/sbin/iptables -t nat -S RETHINK_DNAT
/usr/sbin/iptables -t nat -L RETHINK_DNAT -n -v --line-numbers
```

정상이라면 `PREROUTING`에는 다음 jump가 하나만 보입니다.

```text
-A PREROUTING -j RETHINK_DNAT
```

에어컨 예시의 실제 규칙은 전용 체인에서 다음처럼 보입니다.

```text
-A RETHINK_DNAT -s 192.168.0.45/32 -p tcp -m tcp --dport 443 -j DNAT --to-destination 192.168.0.4:4433
-A RETHINK_DNAT -s 192.168.0.45/32 -p tcp -m tcp --dport 8883 -j DNAT --to-destination 192.168.0.4:8883
```

이전 버전에서 `PREROUTING`에 직접 추가한 동일 규칙도 상태 조회에서 인식합니다. 해당 행을 `Off`로 바꾸면 전용 체인과 기존 `PREROUTING`에서 정확히 일치하는 그 기기의 규칙만 제거합니다.

### 4-6. 감지된 기기 연결(Link)

DNAT와 conntrack 정리 후 1~2분 기다리면 Device 열에 감지된 LG 기기가 나타납니다. 선택 목록에서 실제 기기를 선택하고 **Link**를 누릅니다.

ASUS의 NAT 처리 방식 때문에 감지 목록에는 기기 IP 대신 공유기 IP가 표시될 수 있습니다. 예를 들어 `Air Conditioner — 192.168.0.1`로 보여도 정상입니다. 왼쪽 IP 열의 `192.168.0.45`가 관리에 사용하는 실제 기기 IP이며, Link해도 이 값이 공유기 IP로 바뀌지 않습니다.

기기가 여러 대라면 한 번에 모두 켜지 말고 한 대씩 다음 순서로 진행하세요.

1. 실제 기기 IP를 Add device로 등록
2. DNAT `On`
3. 감지된 모델명과 기기 이름 확인
4. 해당 기기를 Link
5. Bridge `On`
6. LG ThinQ 앱과 Home Assistant 동작 확인

### 4-7. Bridge 켜기와 끄기

Link가 끝나면 DNAT 관리 화면의 Bridge 스위치를 켤 수 있습니다. 이 스위치와 기본 Rethink 관리 화면의 Bridge 스위치는 같은 `enable()`·`disable()` 동작을 사용합니다.

- Bridge `On`: LG 클라우드용 Bridge 인증서를 발급·저장하고 클라우드 중계를 시작합니다.
- Bridge `Off`: Bridge 연결을 종료하고 저장된 해당 기기의 Bridge 인증서를 삭제합니다.
- DNAT `Off`: Bridge가 켜져 있으면 거부됩니다. 반드시 `Bridge Off → DNAT Off` 순서로 진행합니다.

Bridge를 활성화하면 rethink의 로컬 MQTT 엔티티와 LG ThinQ 앱을 함께 사용할 수 있습니다. 기기가 보이지 않으면 Bridge를 반복해서 켜기보다 DNAT 상태, `RETHINK_DNAT` 패킷 카운터, conntrack과 rethink 로그를 먼저 확인하세요.

### 4-8. DNAT 끄기와 목록 제거

DNAT `Off`는 해당 IP의 443·8883 규칙을 전용 체인과 기존 직접 규칙에서 제거하고, 해당 conntrack을 정리합니다. ASUS의 다른 NAT 규칙에는 손대지 않습니다.

**Remove**는 DNAT가 `Off`일 때만 사용할 수 있으며, 해당 IP 행을 DNAT 관리 목록에서 삭제합니다. LG ThinQ 기기 등록이나 Home Assistant 엔티티를 삭제하지는 않습니다. 다시 관리하려면 Add device에서 IP를 수동으로 등록해야 합니다.

**Rename**은 DNAT 관리 화면의 표시 이름만 바꿉니다. LG ThinQ 앱이나 Home Assistant의 기기 이름은 변경하지 않습니다. 빈 이름을 저장하면 감지된 이름으로 돌아갑니다.

### 4-9. 공유기 재부팅 후 복구

ASUS 순정 펌웨어에서는 공유기 재부팅이나 방화벽 재시작 후 사용자가 추가한 체인과 DNAT 규칙이 사라질 수 있습니다. DNAT 관리 화면을 새로 열거나 **Refresh**를 누르면 공유기의 실제 규칙을 다시 조회하므로 해당 기기가 `Off`로 표시됩니다.

복구 순서는 다음과 같습니다.

1. DNAT 관리 화면에서 Router 상태가 `Connected`인지 확인합니다.
2. 규칙이 사라진 기기의 DNAT를 `On`으로 바꿉니다.
3. 관리 기능이 전용 체인과 기기별 규칙을 중복 없이 다시 만들고 conntrack을 정리합니다.
4. 1~2분 후 기기와 Bridge가 다시 연결되는지 확인합니다.

공유기 장애로 기기 연결만 끊어진 경우에는 저장된 Bridge 인증서가 삭제되지 않습니다. DNAT가 복구되고 같은 기기가 다시 접속하면 저장된 상태로 Bridge 연결을 재개할 수 있습니다. 사용자가 Bridge 스위치를 직접 `Off`한 경우에는 인증서가 삭제되므로 다음 `On`에서 새로 발급합니다.

이 상황은 Rethink를 제거하는 원복이 아닙니다. 컨테이너의 데이터 볼륨과 Bridge 상태를 그대로 유지하고, 관리 화면에서 Bridge를 끄거나 `state/`의 기기 파일을 삭제하지 마세요. DNAT만 복구하면 되므로 LG ThinQ 앱에서 기기를 재등록할 필요가 없습니다.

### 4-10. 명령어로 직접 적용하는 대체 방법

웹 관리 기능을 사용하지 않을 때만 아래처럼 `PREROUTING`에 직접 추가할 수 있습니다. 웹 관리 방식과 혼용하지 않는 것을 권장합니다.

```sh
/usr/sbin/iptables -t nat -I PREROUTING 1 -s 192.168.0.45 -p tcp --dport 443 -j DNAT --to-destination 192.168.0.4:4433
/usr/sbin/iptables -t nat -I PREROUTING 1 -s 192.168.0.45 -p tcp --dport 8883 -j DNAT --to-destination 192.168.0.4:8883
/usr/sbin/conntrack -D -s 192.168.0.45 -p tcp --dport 443
/usr/sbin/conntrack -D -s 192.168.0.45 -p tcp --dport 8883
```

같은 명령을 반복하면 중복 규칙이 생길 수 있습니다. 웹 관리 기능은 기존 직접 규칙을 인식하지만, 앞으로는 전용 체인에서 일관되게 관리하는 편이 안전합니다.

### 4-11. 영구 규칙을 지원하는 펌웨어

ASUS 순정 펌웨어에서 재부팅 후 자동 복구를 보장하지는 않습니다.

재부팅 후에도 규칙을 자동으로 유지하려면 공유기가 지원하는 경우 **Asuswrt-Merlin** 또는 **OpenWrt** 같은 커스텀 펌웨어를 사용할 수 있습니다.

- Asuswrt-Merlin은 JFFS의 `/jffs/scripts/nat-start`처럼 NAT 구성이 완료된 뒤 실행되는 사용자 스크립트를 지원하므로, 여기에 중복 확인을 포함한 DNAT 명령을 등록할 수 있습니다. 자세한 내용은 [Asuswrt-Merlin User scripts](https://github.com/RMerl/asuswrt-merlin/wiki/User-scripts)를 참고하세요.
- OpenWrt는 방화벽 설정 파일에 DNAT 규칙을 영구 등록할 수 있습니다. OpenWrt 22.03 이후의 `fw4`는 nftables 기반이므로 이 문서의 ASUS `iptables` 명령을 그대로 사용하지 말고, UCI 또는 nftables 형식으로 다시 작성해야 합니다. 자세한 내용은 [OpenWrt 방화벽 설정](https://openwrt.org/docs/guide-user/firewall/firewall_configuration)을 참고하세요.

커스텀 펌웨어 설치에는 설정 초기화, 부팅 불가 및 제조사 지원 제한 위험이 있습니다. 먼저 자신의 정확한 공유기 모델과 하드웨어 버전이 해당 펌웨어를 공식적으로 지원하는지 확인하세요. 이 문서에서는 커스텀 펌웨어 설치 및 자동 실행 스크립트 구성까지 다루지 않습니다.

## 5. Home Assistant 확인

rethink는 MQTT Discovery를 사용합니다. `config.json`의 MQTT 주소, ID/PW 및 `discovery_prefix`가 Home Assistant의 MQTT 브로커 설정과 일치해야 합니다.

1. rethink 로그에서 MQTT 연결 오류가 없는지 확인합니다.
2. Home Assistant의 **설정 → 기기 및 서비스 → MQTT**에서 LG 기기를 확인합니다.
3. 엔티티가 비활성화되어 있으면 해당 MQTT 기기 페이지에서 필요한 엔티티를 활성화합니다.
4. 상태 확인부터 하고 전원, 모드, 온도 같은 제어는 한 항목씩 시험합니다.
5. LG ThinQ 앱에서도 같은 기기의 상태와 제어가 정상인지 확인합니다.

지원 목록에 없는 모델은 Connected devices에 나타나고 bridge가 동작해도 Home Assistant 엔티티가 일부만 생성되거나 제어가 동작하지 않을 수 있습니다. 이런 경우 모델별 핸들러 추가가 필요합니다. 핸들러 추가 작업은 rethink 모니터에서 수집한 통신 패킷, 기존 유사 모델의 핸들러와 원하는 Home Assistant 엔티티를 함께 분석해야 하므로 AI 코딩 도구를 이용하여 진행하는 것을 권장합니다. 다만 AI가 생성한 명령과 상태 해석이 항상 정확한 것은 아니므로, 한 번에 하나의 기능만 추가하고 실제 기기에서 안전하게 동작하는지 확인한 뒤 다음 기능으로 확장하세요.

## 6. 업데이트

```sh
cd ~/docker/rethink
git pull --ff-only origin master
docker build --pull -t rethink-lg-bridge:local .

docker stop rethink
docker rm rethink

docker run -d \
  --name rethink \
  --restart unless-stopped \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --network host \
  -v "$HOME/docker/rethink-data:/app/data" \
  rethink-lg-bridge:local
```

업데이트 전 `~/docker/rethink-data`를 백업하는 것을 권장합니다.

`docker stop`과 `docker rm`은 컨테이너만 제거합니다. 위 명령은 호스트의 `~/docker/rethink-data`를 삭제하지 않으므로 기존 `config.json`, CA 및 bridge 상태가 그대로 유지됩니다.

## 7. 운영 전 최종 확인

다음 조건을 모두 확인한 뒤 실제 기기 IP에 DNAT를 적용하세요.

- rethink가 TCP 4433과 8883에서 정상적으로 대기 중
- Home Assistant MQTT 연결 정상
- rethink bridge 로그인 및 기기 인증서 발급 정상
- rethink 서버와 각 LG 기기의 DHCP 고정 IP 설정 완료
- 공유기 DNAT 규칙이 지정한 LG 기기의 TCP 443·8883에만 적용됨
- SNI별 인증서 생성 오류가 로그에 없음

가능하면 미사용 테스트 IP로 DNAT 명령을 먼저 검증하세요.

## 8. 복구와 원복

공유기 재부팅 등으로 DNAT 규칙만 사라진 경우와 Rethink를 완전히 제거하는 경우는 절차가 다릅니다.

| 상황 | 필요한 작업 | ThinQ Wi-Fi 재등록 |
|---|---|---|
| Rethink를 계속 사용하지만 DNAT만 사라짐 | bridge와 데이터 볼륨을 유지한 채 DNAT 재적용 후 conntrack 삭제 | 필요 없음 |
| Rethink를 완전히 제거하고 LG 클라우드 직접 연결로 복귀 | bridge 종료 확인, DNAT 제거, conntrack 삭제, 기기 Wi-Fi 재등록 | 필요 |

### 8-1. Rethink를 계속 사용하는 경우

관리 화면에서 bridge를 끄거나 `state/device_<기기 ID>.json`을 삭제하지 마세요. 공유기의 DNAT 규칙만 다시 적용하고 해당 기기의 443/8883 conntrack을 삭제합니다. 저장된 bridge 인증서와 상태를 그대로 사용하므로 LG ThinQ 앱에서 기기를 재등록할 필요가 없습니다.

### 8-2. Rethink를 완전히 제거하는 경우

영구 원복 순서는 반드시 다음과 같아야 합니다.

1. rethink 관리 화면에서 해당 기기의 bridge를 비활성화합니다.
2. 화면 표시만 확인하지 말고, rethink 로그에서 해당 기기의 LG 클라우드 bridge 연결이 실제로 종료되었는지 확인합니다.
3. DNAT 관리 화면에서 해당 기기의 DNAT를 비활성화합니다.
4. 관리 화면이 해당 기기의 443/8883 conntrack을 정리하고 `Off`로 바뀌는지 확인합니다.
5. 기기를 Wi-Fi 설정 모드로 전환하여 LG ThinQ 앱에서 다시 등록합니다. 기존 오프라인 항목을 먼저 삭제할지는 앱의 안내에 따릅니다.

기존 오프라인 기기를 LG ThinQ 앱에서 삭제하면 방 배치, 별칭, Home Assistant 또는 Google Home 연동이 변경될 수 있으므로 재등록 전에 현재 설정을 확인하세요.

웹 관리 화면을 사용할 수 없으면 규칙이 있는 체인을 먼저 확인한 뒤 기기 한 대의 정확히 일치하는 규칙만 제거합니다. 아래는 전용 체인에 있는 에어컨 규칙을 제거하는 예입니다.

```sh
/usr/sbin/iptables -t nat -D RETHINK_DNAT -s 192.168.0.45/32 -p tcp -m tcp --dport 443 -j DNAT --to-destination 192.168.0.4:4433
/usr/sbin/iptables -t nat -D RETHINK_DNAT -s 192.168.0.45/32 -p tcp -m tcp --dport 8883 -j DNAT --to-destination 192.168.0.4:8883
/usr/sbin/conntrack -D -s 192.168.0.45 -p tcp --dport 443
/usr/sbin/conntrack -D -s 192.168.0.45 -p tcp --dport 8883
```

이전 방식으로 규칙이 `PREROUTING`에 직접 들어가 있다면 위 두 삭제 명령의 체인 이름만 `PREROUTING`으로 바꿉니다. 규칙이 존재하는지 확인하지 않고 `-D`를 반복 실행하지 마세요.

bridge를 켜 둔 채 DNAT만 제거하면 rethink와 실제 가전이 같은 MQTT client ID로 LG 클라우드에 접속하면서 서로 연결을 끊을 수 있습니다.

다만 bridge를 먼저 끄더라도 원래 기기의 직접 클라우드 연결이 자동으로 복구된다는 의미는 아닙니다. `PAC_910604_WW`에서는 중복 MQTT client ID 연결, upstream MQTT 연결 및 추가 등록 작업 없이 Rethink용 bridge 인증서만 발급한 분리 실험에서도 직접 복귀가 실패했습니다. LG 서버가 원래 인증 자격을 어떻게 처리했는지는 직접 확인할 수 없으므로 정확한 서버 내부 원인은 단정하지 않지만, 영구 원복에는 ThinQ Wi-Fi 재등록이 필요했습니다.


## 운영 데이터와 보안

다음 항목은 공개 Git 저장소에 올리지 마세요.

```text
config.json
router-dnat.json
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

Rethink를 계속 사용할 계획이라면 공유기 재부팅이나 일시적인 통신 장애를 해결하기 위해 bridge를 끄거나 `state/` 파일을 삭제하지 마세요. bridge를 다시 활성화하는 과정에서 새 인증서가 발급될 수 있습니다. `state/`는 지속적으로 보존하되 개인키가 포함되어 있으므로 공개 저장소나 공유 백업 공간에는 저장하지 마세요.

## 관리 화면과 도구

기본 관리 화면 포트는 TCP 44401입니다. 관리 화면에서는 다음 기능을 제공합니다.

- rethink에 연결된 기기 목록 확인
- 통신 모니터링 및 패킷 주입
- bridge 설정
- ASUS 공유기 SSH 연결 설정과 상태 확인
- 기기 IP별 DNAT 적용·해제 및 conntrack 정리
- 감지된 ThinQ 기기와 수동 등록 IP 연결

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
