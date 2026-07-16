---
title: Headscale 极简部署指南
date: 2026-02-12 00:00:00
categories:
  - 运维
tags:
  - headscale
  - tailscale
toc: true
---

## 0. 架构与端口规划（先把端口定死）

| 服务 | 协议/端口 | 说明 | 谁访问谁 |
| :--- | :--- | :--- | :--- |
| **HTTPS** | `TCP/443` | Headscale 控制面 + DERP（经反代，含 Upgrade） | 公网 → Nginx/OpenResty |
| **STUN** | `UDP/3478` | 内置 STUN（打洞关键） | 公网 → Headscale（直连到服务器） |
| **Peer Relay** | `UDP/443` | Peer Relay 数据转发（由 `tailscaled` 监听） | Tailnet 节点 → Peer Relay 节点 |
| **Local** | `TCP/3477` | Headscale 本体（仅本机监听） | Nginx/OpenResty → Headscale |

关键点：

- **`3478` 必须放行 UDP（不是 TCP）**：很多云安全组 TCP/UDP 分开选，别选错。
- `UDP/3478` 只用于 STUN/NAT 探测，不承载 DERP 转发数据。
- `TCP/443` 与 `UDP/443` 协议不同，可以在同一台服务器上分别由 Nginx 和 `tailscaled` 监听。
- **不要对公网暴露 `3477`**：只监听 `127.0.0.1`，由反代统一出入口。

---

## 1. 前置准备（替换占位符）

把下面占位符替换成你的值：

- `hs.example.com`：你的控制面域名（必须 HTTPS 可访问）
- `SERVER_PUBLIC_IP`：服务器公网 IPv4
- `REGION_CODE`：自建 DERP code（建议小写，例如 `myderp`）

准备项：

- 一台 Linux 服务器（有公网 IPv4）
- 一个域名 A 记录指向 `SERVER_PUBLIC_IP`
- 已有证书（或你能自己搞定 ACME 申请；本文不展开）
- Nginx 或 OpenResty 已安装

---

## 2. 安装 Headscale（二进制）

从 `juanfont/headscale` 的 Releases 下载与你机器架构匹配的二进制：

- [`juanfont/headscale` Releases](https://github.com/juanfont/headscale/releases)

安装到 `/usr/local/bin/headscale`：

```bash
sudo cp ./headscale /usr/local/bin/headscale
sudo chmod 0755 /usr/local/bin/headscale
/usr/local/bin/headscale version
```

> 小坑：如果遇到 `sudo headscale: command not found`，多半是 `sudo` 的 `secure_path` 不含 `/usr/local/bin`。本文后续统一用绝对路径：`sudo /usr/local/bin/headscale ...`

---

## 3. 生成必须密钥（v0.28+ 常见强制项）

创建目录：

```bash
sudo mkdir -p /etc/headscale /var/lib/headscale
sudo chmod 700 /var/lib/headscale
```

生成 Noise 私钥：

```bash
sudo /usr/local/bin/headscale generate private-key \
  | sudo tee /var/lib/headscale/noise_private.key >/dev/null
sudo chmod 600 /var/lib/headscale/noise_private.key
```

> 说明：这里用 `tee` 是为了解决“`sudo` + 重定向”权限问题（`sudo cmd > file` 的重定向不在 sudo 权限里执行）。  
> 另外，内容通常带 `privkey:` 前缀，别手动删，否则可能报 “expected type prefix privkey:”。

---

## 4. 写入 Headscale 配置（最小可用模板）

保存为：`/etc/headscale/config.yaml`

> 说明：先**关闭 DNS/MagicDNS**，减少必填项耦合；跑通后再按「进阶」章节开启。

```yaml
# /etc/headscale/config.yaml

# 必须替换：你的控制面公网 HTTPS 地址（反代场景也一样）
server_url: "https://hs.example.com" # ← 替换为你的域名

# 只在本机监听，由 Nginx/OpenResty 对外提供 443
listen_addr: "127.0.0.1:3477"

tls_cert_path: ""
tls_key_path: ""

prefixes:
  v4: "100.64.0.0/10"
  v6: "fd7a:115c:a1e0::/48"

database:
  type: sqlite
  sqlite:
    path: "/var/lib/headscale/db.sqlite"

# v0.28+ 常见强制项：Noise 私钥
noise:
  private_key_path: "/var/lib/headscale/noise_private.key"

# 先关闭 DNS 功能，避免引入 base_domain/nameservers 等额外必填项
dns:
  magic_dns: false
  override_local_dns: false

derp:
  server:
    enabled: true
    # 可替换：自建 DERP 的 region 信息（便于识别/排查；避免与官方冲突即可）
    region_id: 901                 # ← 可改；只要不和官方/其他自建重复即可
    region_code: "REGION_CODE"     # ← 必须替换：建议小写，例如 "myderp"
    region_name: "REGION_NAME"     # ← 必须替换：随便取一个可读名字即可

    private_key_path: "/var/lib/headscale/derp_server_private.key"

    # STUN（UDP/3478）
    stun_listen_addr: "0.0.0.0:3478"

    # 告诉客户端 DERP 的公网入口（域名 + 公网 IPv4）
    hostname: "hs.example.com"     # ← 必须替换：你的域名（与 server_url 一致）
    ipv4: "SERVER_PUBLIC_IP"       # ← 必须替换：服务器公网 IPv4

    # 更安全：只允许你 tailnet 的节点使用这个 DERP
    verify_clients: true

    automatically_add_embedded_derp_region: true

  # 建议保留官方 DERP 兜底（否则单点）
  urls:
    - "https://controlplane.tailscale.com/derpmap/default"
  paths: []

log:
  level: "info"
```

配置校验（必须过）：

```bash
sudo /usr/local/bin/headscale configtest -c /etc/headscale/config.yaml
```

---

## 5. systemd 启动 Headscale

创建：`/etc/systemd/system/headscale.service`

```ini
[Unit]
Description=Headscale
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/headscale serve -c /etc/headscale/config.yaml
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

启动并自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now headscale
sudo systemctl status headscale --no-pager
```

> 生产提示：为简单起见，上面未指定 `User=`/`Group=`，默认 root 运行。生产环境建议创建专用用户（如 `headscale`）并收紧 `/var/lib/headscale` 权限后再以非 root 运行。

---

## 6. Nginx/OpenResty 反代（关键是 Upgrade + 长连接）

示例：`/etc/nginx/conf.d/headscale.conf`

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  http2 on;
  server_name hs.example.com;

  ssl_certificate     /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3477;

    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;

    # DERP/控制面都可能需要 Upgrade（保险起见全站都保留）
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering off;
  }
}
```

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 7. 创建用户 + 客户端接入

先说明一下什么是“用户（user）”：

- Headscale 的 **user** 不是登录账号/密码体系，而是一个**命名空间/分组**：把一批设备（nodes）归到同一个用户下面，便于管理与发放入网 key。
- **个人/小团队最常见**：只建 1 个 user，然后所有设备都加入这个 user。
- `tailnet-user` 只是示例名，你可以改成自己的（例如 `alice` / `team-a`）。

创建用户：

```bash
# 创建一个 user（示例名：tailnet-user）
sudo /usr/local/bin/headscale users create tailnet-user
sudo /usr/local/bin/headscale users list
```

生成 preauth key（优先用用户名；旧版本不支持再用数字 ID）：

```bash
# 优先：直接用用户名
sudo /usr/local/bin/headscale preauthkeys create -u tailnet-user --reusable --expiration 24h

# 兜底：用 users list 里的 USER_ID
sudo /usr/local/bin/headscale preauthkeys create -u USER_ID --reusable --expiration 24h
```

客户端加入（Linux 示例）：

```bash
sudo tailscale up \
  --reset \
  --login-server https://hs.example.com \
  --authkey hskey-auth-xxxxxxxxxxxxxxxx \
  --accept-dns=false \
  --accept-routes
```

> 后续新增设备：重复本节“生成 key → 客户端 tailscale up”即可。

---

## 8. 验收清单（所有检查统一在这里做）

### 8.1 服务器侧

```bash
sudo /usr/local/bin/headscale configtest -c /etc/headscale/config.yaml
systemctl status headscale --no-pager
sudo ss -lntp | egrep ':443|:3477'
sudo ss -ulnp | egrep ':3478'
curl -i https://hs.example.com/derp
sudo /usr/local/bin/headscale nodes list
```

看到 `curl -i https://hs.example.com/derp` 返回 `426` 且包含 `DERP requires connection upgrade`：**正常**（代表路由打通）。

### 8.2 客户端侧（最重要）

```bash
tailscale status
tailscale ping <peer_100.64.x.x>
tailscale netcheck
```

`tailscale status` 速记：

- `relay` / `via DERP(...)`：走 DERP 中继（慢一些，但能通）
- `peer-relay`：走 Tailnet 内的 Peer Relay UDP 中继
- `direct`：P2P 打洞成功（更快、更稳定）

通常按 `direct → Peer Relay → DERP` 的顺序选择可用路径；已经直连的节点不会因为配置了 Peer Relay 而绕行。

---

## 9. 常见疑难杂症（只保留“现象级”问题）

### Q1：一直走很远的 DERP（例如 `DERP(nue)`），不走自己的 `REGION_CODE`

优先用裁判命令：

```bash
tailscale netcheck
```

常见原因：

- `derp.server.hostname/ipv4` 没配全或配错
- 客户端被代理影响（`netcheck` 会出现 `tshttpproxy: using proxy ...`）

### Q2：客户端日志出现 `dial tcp4 SERVER_PUBLIC_IP:3477: i/o timeout`

典型“反代场景端口混淆”：

- 客户端误以为 DERP 对外端口是 3477
- 但 3477 只在本机回环监听，公网必超时

根治：确保 `server_url` 是 `https://hs.example.com`，并在 `derp.server` 明确：

- `hostname: hs.example.com`
- `ipv4: SERVER_PUBLIC_IP`

### Q3：macOS 节点名变成 `invalid-xxxxx`

Headscale 对 hostname 限制严格（小写字母/数字/`-`/`.`）。macOS 设备名带中文/空格等会被拒绝。

修复：在服务器端用 `headscale nodes rename` 改“显示名”（需要节点 ID；先用 `headscale nodes list` 查到 ID 即可）。示例（一步）：

```bash
sudo /usr/local/bin/headscale nodes rename -i <node-id> mac-home
```

### Q4：`tailscale debug derp REGION_CODE` 里 IPv6 报错，但 IPv4 OK

域名只有 A 记录、无 AAAA 且服务器无公网 IPv6 时属于正常探测失败；只要实际 `tailscale ping` 正常即可忽略。

---

## 10. 进阶（可选）：MagicDNS / Split DNS / Subnet Router

### 10.1 MagicDNS：用机器名互访

开启 MagicDNS 时必须配置 `base_domain`，并且它不能与 `server_url` 使用相同域名：

```yaml
dns:
  magic_dns: true
  base_domain: tailnet.internal
  override_local_dns: false
  nameservers:
    global:
      - 1.1.1.1
      - 8.8.8.8
```

客户端必须接受 Headscale 下发的 DNS 配置：

```bash
sudo tailscale set --accept-dns=true
```

检查：

```bash
tailscale debug prefs
```

其中 `CorpDNS: true` 等价于 `accept-dns=true`。这是 Tailscale 客户端的默认行为；只有曾主动关闭过 DNS 接收的客户端才需要重新设置。

`override_local_dns` 与 `accept-dns` 控制的是不同层次：

| 设置 | 作用 |
| :--- | :--- |
| 客户端 `accept-dns=true` | 接受 MagicDNS、Split DNS 等 Headscale DNS 配置 |
| 服务端 `override_local_dns=false` | 普通域名继续使用客户端当前网络的本地 DNS |
| 服务端 `override_local_dns=true` | 强制普通域名使用 `nameservers.global`，覆盖本地 DNS |

如果目标只是 MagicDNS 和 Split DNS，不想影响家里、公司或移动网络原有的 DNS，保持 `override_local_dns: false`。

### 10.2 Split DNS：只分流特定后缀到内网 DNS

下面全部使用虚构域名和示例地址，部署时替换成实际值：

```yaml
dns:
  magic_dns: true
  base_domain: tailnet.internal

  # 不强制覆盖客户端本地 DNS
  override_local_dns: false

  nameservers:
    global:
      - 1.1.1.1
      - 8.8.8.8

    # 只有匹配后缀的查询才交给内网 DNS
    split:
      corp.example:
        - 10.20.0.53
        - 10.20.0.54
```

此配置的实际行为：

- `*.corp.example` 查询 `10.20.0.53/54`。
- MagicDNS 名称由 Tailscale/Headscale 处理。
- 其他普通域名仍使用客户端所在网络的本地 DNS。
- `nameservers.global` 不会在 `override_local_dns: false` 时强制替换本地 DNS。

修改后校验并重启 Headscale：

```bash
sudo /usr/local/bin/headscale configtest -c /etc/headscale/config.yaml
sudo systemctl restart headscale
```

关键前提：客户端必须能够到达内网 DNS。如果 DNS 位于公司私网，Subnet Router 至少要广播 DNS 地址，例如：

```text
10.20.0.53/32
10.20.0.54/32
```

先验证 DNS 网络连通性：

```bash
dig @10.20.0.53 service.corp.example A
dig +tcp @10.20.0.53 service.corp.example A
```

再验证操作系统实际使用 Split DNS。Linux 推荐：

```bash
resolvectl query service.corp.example
```

macOS 推荐：

```bash
dscacheutil -q host -a name service.corp.example
```

普通 `dig service.corp.example` 可能绕过操作系统的域名分流机制，不应作为 Split DNS 是否生效的唯一判断依据。

### 10.3 Subnet Router：把内网路由接入 Tailnet

在内网选择一台长期在线的 Linux 机器作为中转节点。它必须同时满足：

- 已加入同一个 Headscale。
- 自己能够访问目标 DNS 和业务服务。
- 防火墙允许 `tailscale0` 与内网网卡之间转发。
- 启用内核 IP forwarding。

#### 10.3.1 确认内网路径

先检查中转机自身网络：

```bash
ip -br addr
ip route
ip route get 10.20.0.53
```

客户端通常只能看到直连网段和默认网关，无法从本机路由表反推出企业网络的全部 CIDR。不要未经确认直接广播整个 `10.0.0.0/8` 或 `172.16.0.0/12`；它们容易与家庭网络、Docker、虚拟机或其他 VPN 冲突。

更稳妥的做法是：

1. 从网络管理员获取真实路由/VLAN 清单。
2. 根据需要访问的内部域名解析出服务 IP。
3. 不确定掩码时先使用 `/32` 主机路由。
4. 确认真实 CIDR 后再合并路由。

#### 10.3.2 开启 IPv4 转发

```bash
echo 'net.ipv4.ip_forward = 1' \
  | sudo tee /etc/sysctl.d/99-tailscale-subnet-router.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale-subnet-router.conf
```

确认：

```bash
sysctl net.ipv4.ip_forward
```

必须返回：

```text
net.ipv4.ip_forward = 1
```

只有确实需要转发 IPv6 时，才额外开启：

```text
net.ipv6.conf.all.forwarding = 1
```

#### 10.3.3 广播路由

示例中广播一个业务网段和两台内网 DNS：

```bash
sudo tailscale set \
  --accept-routes=false \
  --advertise-routes=10.30.0.0/16,10.20.0.53/32,10.20.0.54/32
```

注意：

- 已登录节点使用 `tailscale set`，避免 `tailscale up` 要求重新声明其他非默认参数。
- 更新 `--advertise-routes` 时提供完整列表，新值会替换旧列表。
- 中转机通常设置 `--accept-routes=false`，避免接受自己或其他中转机广播的相同路由。
- 保持默认 SNAT，不要设置 `--snat-subnet-routes=false`。默认 SNAT 下，内网服务看到的来源是中转机的内网 IP，无需在企业路由器上增加 `100.64.0.0/10` 返回路由。

检查：

```bash
tailscale debug prefs
```

期望看到：

```text
RouteAll: false
NoSNAT: false
AdvertiseRoutes: [...]
```

#### 10.3.4 在 Headscale 批准路由

当前版本使用节点路由命令：

```bash
sudo /usr/local/bin/headscale nodes list-routes
```

找到中转节点 ID 后，批准它当前广播的完整路由集合：

```bash
sudo /usr/local/bin/headscale nodes approve-routes \
  --identifier <node-id> \
  --routes 10.30.0.0/16,10.20.0.53/32,10.20.0.54/32
```

再次检查：

```bash
sudo /usr/local/bin/headscale nodes list-routes
```

路由应同时出现在：

```text
Approved
Available
Serving (Primary)
```

Headscale 的 `config.yaml` 不需要为每条 Subnet Route 增加配置；路由由节点广播，再通过上述命令批准。

#### 10.3.5 其他客户端接收路由

Linux 默认通常不接受 Subnet Routes，需要执行：

```bash
sudo tailscale set --accept-routes=true --accept-dns=true
```

检查 Linux 策略路由：

```bash
tailscale debug prefs
ip route show table 52
```

Windows、Android、iOS 和官方 macOS 客户端通常会自动接收已批准的路由，仍建议使用系统路由命令验证实际选路。

如果某台电脑长期位于公司内网，不希望它绕行 Subnet Router，可以在该节点关闭路由接收，同时继续接受 Split DNS：

```bash
sudo tailscale set --accept-routes=false --accept-dns=true
```

此时 `tailscale debug prefs` 应显示：

```text
RouteAll: false
CorpDNS: true
```

#### 10.3.6 验证顺序

从外部客户端依次检查：

```bash
# 1. Tailscale 中转节点可达
tailscale ping <router-tailscale-ip>

# 2. Linux 已收到路由
ip route show table 52

# 3. 内网 DNS 可达
dig @10.20.0.53 service.corp.example A

# 4. 系统 Split DNS 生效
resolvectl query service.corp.example

# 5. 业务端口可达；避免测试时被本机 HTTP 代理截走
curl --noproxy '*' -vk --connect-timeout 5 --max-time 15 \
  https://service.corp.example/
```

故障定位：

- `tailscale ping` 失败：先查 Headscale、节点在线状态和 DERP/直连。
- table 52 没有目标路由：检查 `accept-routes`、路由批准状态及客户端版本。
- DNS IP 不通：检查 IP forwarding、中转机防火墙、SNAT 和路由范围。
- 指定 DNS 查询成功但系统解析失败：检查 Split DNS、`accept-dns` 和 `systemd-resolved`。
- 域名能解析但业务 IP 不通：DNS 返回的地址不在已广播路由中，需要追加对应 CIDR。

### 10.4 Peer Relay：直连失败时优先使用 UDP 中继

DERP 能保证复杂网络下的可达性，但数据通常经 TCP/TLS 转发，吞吐和延迟容易受 TCP-over-TCP、跨网质量及拥塞影响。Peer Relay 是一个加入同一 Tailnet 的 Tailscale 节点，通过 UDP 转发其他节点的加密流量；业务数据仍保持端到端加密，Relay 节点不能解密其内容。

本文采用以下部署方式：

- Headscale、内置 DERP 与 Peer Relay 位于同一台公网 Linux 服务器。
- Nginx 使用 `TCP/443` 提供控制面和 DERP。
- `tailscaled` 使用 `UDP/443` 提供 Peer Relay。
- 该 Tailscale 节点只承担 Peer Relay，不接收 DNS、Subnet Routes，也不广播路由或 Exit Node。
- Peer Relay 不会替代 DERP；UDP Relay 不可用时，客户端仍可自动回退到 DERP。

> Peer Relay 至少需要 Tailscale 1.86。Headscale 也必须是支持 Grants 的版本；本文方案验证于 Headscale 0.29.x。升级前先备份配置和数据库，并以当前版本的 release notes 为准。

参考：[Tailscale Peer Relays](https://tailscale.com/docs/features/peer-relay)、[Headscale Policy](https://headscale.net/stable/ref/policy/)。

#### 10.4.1 放行端口

在云安全组和主机防火墙中放行：

```text
UDP/443    任意需要使用 Peer Relay 的客户端 → Relay 服务器
```

同一台服务器已有 `TCP/443` 不冲突，因为 TCP 和 UDP 是两套独立端口空间。普通 Tailscale 节点常用的 `UDP/41641` 也建议保持可用，以便优先尝试端到端直连。

如果所在网络明确封锁 `UDP/443`，也可以改用其他 UDP 端口，例如 `3479`；端口号本身不保证性能，需要在实际网络中 A/B 测试。

#### 10.4.2 配置最小 Policy

新建 `/etc/headscale/policy.hujson`：

```hujson
{
  "tagOwners": {
    "tag:peer-relay": ["tailnet-user@"]
  },

  "acls": [
    {
      "action": "accept",
      "src": ["*"],
      "dst": ["*:*"]
    }
  ],

  "grants": [
    {
      "src": ["*"],
      "dst": ["tag:peer-relay"],
      "app": {
        "tailscale.com/cap/relay": []
      }
    }
  ]
}
```

其中：

- `tagOwners` 允许指定用户创建或管理 `tag:peer-relay` 节点。
- `acls` 保持整个 Tailnet 的普通节点通信和 Subnet Routes 全部放行。
- `grants` 允许所有当前及以后加入的节点使用带 `tag:peer-relay` 标签的中继。
- 启用 Policy 后，后续新增 Subnet Route 不需要逐条修改上述 ACL，因为 `dst: ["*:*"]` 已全部放行；但路由仍需在 Headscale 中批准。

这是适合个人、单用户 Tailnet 的简化配置。`src: ["*"]` 和 `dst: ["*:*"]` 权限很宽；多用户环境应改成具体用户、标签或主机选择器，遵循最小权限原则。

在 `/etc/headscale/config.yaml` 中启用文件策略：

```yaml
policy:
  mode: file
  path: /etc/headscale/policy.hujson
```

校验配置：

```bash
sudo /usr/local/bin/headscale policy check \
  --file /etc/headscale/policy.hujson
sudo /usr/local/bin/headscale configtest \
  -c /etc/headscale/config.yaml
```

第一次增加 `policy.path` 后重启 Headscale：

```bash
sudo systemctl restart headscale
sudo systemctl --no-pager --full status headscale
```

以后仅修改 Policy 文件时，可以发送 `SIGHUP` 让 Headscale 重新加载：

```bash
sudo kill -HUP "$(pidof headscale)"
```

#### 10.4.3 注册专用 Relay 节点

先在 Headscale 服务器创建一个短期、带标签的预授权密钥：

```bash
sudo /usr/local/bin/headscale preauthkeys create \
  --user <user-id> \
  --expiration 10m \
  --tags tag:peer-relay
```

不要把输出的密钥写进脚本、Git、聊天记录或文章。可以将它临时放入仅 root 可读的文件：

```bash
sudo install -m 600 /dev/null /run/tailscale-peer-relay.authkey
sudoedit /run/tailscale-peer-relay.authkey
```

在同一台公网服务器安装并启动 Tailscale 后，注册专用节点：

```bash
sudo tailscale up \
  --reset \
  --login-server=https://hs.example.com \
  --auth-key=file:/run/tailscale-peer-relay.authkey \
  --hostname=peer-relay \
  --accept-dns=false \
  --accept-routes=false \
  --ssh=false

sudo rm -f /run/tailscale-peer-relay.authkey
```

预授权密钥已经携带标签，因此这里不需要再传 `--advertise-tags`。`--reset` 用于清除该客户端可能残留的非默认参数；不要在已有其他职责的生产节点上未经检查直接使用。

检查注册结果：

```bash
sudo /usr/local/bin/headscale nodes list
```

预期能看到类似信息：

```text
Name         User            Tags
peer-relay   tagged-devices  tag:peer-relay
```

带标签的节点显示为 `tagged-devices` 是正常行为：它的访问身份由标签和 Policy 管理，而不是继续显示为普通用户节点。

#### 10.4.4 启动 Peer Relay

让公网服务器上的 `tailscaled` 监听 `UDP/443`：

```bash
sudo tailscale set \
  --relay-server-port=443
```

如果服务器存在多网卡、NAT 或自动探测到的公网端点不正确，可以显式声明静态端点：

```bash
sudo tailscale set \
  --relay-server-static-endpoints="SERVER_PUBLIC_IP:443"
```

这台节点只做 Relay，不需要：

- 开启 IP forwarding。
- 设置 `--advertise-routes`。
- 广播 Exit Node。
- 接受 Headscale DNS 或其他节点的 Subnet Routes。

检查 UDP 监听和客户端偏好：

```bash
sudo ss -lunp | grep ':443'
sudo tailscale debug prefs | grep -E 'RelayServerPort|RouteAll|CorpDNS'
```

#### 10.4.5 验证客户端是否实际使用 Peer Relay

从两个无法直连的普通节点互相发起流量，然后检查：

```bash
tailscale ping <peer-name-or-tailscale-ip>
tailscale status
```

使用成功时，`tailscale status` 会出现类似状态：

```text
active; peer-relay SERVER_PUBLIC_IP:443:vni:... tx ... rx ...
```

如果仍显示 `relay` 或 `via DERP(...)`，依次检查：

1. 两端 Tailscale 是否达到支持 Peer Relay 的版本。
2. Relay 节点是否在线并带有 `tag:peer-relay`。
3. Policy 中的 Relay Grant 是否已经加载。
4. 服务器是否监听 `UDP/443`，云安全组和主机防火墙是否放行。
5. 客户端所在网络是否封锁 UDP；可临时更换网络做对照测试。

关闭 Peer Relay 进行回退验证：

```bash
sudo tailscale set --relay-server-port=""
```

Relay 关闭后，无法直连的节点应自动回到 DERP。重新启用：

```bash
sudo tailscale set --relay-server-port=443
```

#### 10.4.6 脱敏后的测速对比

下面是一组同一对客户端、同一测试方法下的实测样本。每项使用单 TCP 流测试 10 秒并忽略前 2 秒，数值只能反映当时的接入网络和线路质量：

| 路径 | 客户端 A → B | 客户端 B → A |
| :--- | ---: | ---: |
| DERP（`TCP/443`） | 6.02 Mbps | 12.19 Mbps |
| Peer Relay（`UDP/3479`，对照） | 14.64 Mbps | 9.51 Mbps |
| Peer Relay（`UDP/443`，最终） | 13.05 Mbps | 15.80 Mbps |

与 DERP 相比，本次 `UDP/443` Peer Relay 样本中 A → B 提升约 117%，B → A 提升约 30%。两个方向简单相加约提升 58%，但该加和值不是同时双向吞吐量。

测试命令：

```bash
# 客户端 B
iperf3 -s

# 客户端 A：正向与反向分别测试
iperf3 -c <peer-tailscale-ip> -t 10 -O 2
iperf3 -c <peer-tailscale-ip> -R -t 10 -O 2
```

结论不是“UDP/443 永远比其他端口快”，而是 Peer Relay 在这组无法直连的节点上相对 DERP 有明确收益，且 `UDP/443` 的双向表现更均衡。最终选择前应固定终端、时间、并发数和测试方向做多轮 A/B 测试，同时观察丢包、抖动和 `tailscale status`，确认测试期间没有发生路径切换。
