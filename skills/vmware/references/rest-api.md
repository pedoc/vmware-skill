# VMware Workstation REST API 参考

REST 只在 CLI 做不到时用（新增网卡、新建虚拟网络、克隆 VM、改 CPU/内存）。
规格来源：`C:\Program Files\VMware\VMware Workstation\swagger.zip` → `json/swagger_WS.json`。

## 启动

```sh
VMREST="/c/Program Files/VMware/VMware Workstation/vmrest.exe"

"$VMREST" -C     # 一次性配置凭据（交互式）
"$VMREST"        # 启动服务，监听 127.0.0.1:8697
```

`-C` 会交互式要用户名 + 两次新密码。**密码复杂度**：≥8 位、至少一个小写字母、至少一个数字、
至少一个特殊字符（`!#$%&'()*+,-./:;<=>?@[]^_\`{|}~`）。

不配置直接跑会报 `To listen on TCP port, Please use -C to update credential` 然后退出。

## 认证

HTTP Basic。环境变量：

```sh
export VMWARE_REST_USER=...
export VMWARE_REST_PASSWORD=...
```

也支持 `VMWARE_REST_HOST`（默认 `127.0.0.1`）、`VMWARE_REST_PORT`（默认 `8697`）。

Base URL：`http://<host>:<port>/api`

**Content-Type 必须是 `application/vnd.vmware.vmw.rest-v1+json`**，写操作尤其如此。
用普通的 `application/json` 会收到 `HTTP 406 "Content type not supported"`
（看起来像路径或参数写错，实际只是媒体类型不对）。

## 权限分层（实测）

不是所有写操作都能用。以 Administrator 身份运行 vmrest 时实测：

| 范围 | 写操作 | 结果 |
|---|---|---|
| VM 本身 | `vm-update`（改 CPU/内存）、`power-set` | 可用 |
| VM 文件夹 | `folder-create` / `folder-delete` | 可用 |
| **虚拟网络层** | `portforward`（PUT/DELETE）、`vmnets`（PUT）、`mactoip` | **一律 403** `The operation is not permitted` |

网络层写操作的 403 不是因为凭据错误——同一凭据的 `GET` 与 VM 写操作都正常。
这是 VMware 对 vmnet 配置的额外限制。需要修改端口转发或新建虚拟网络时，
用 `vmrun setPortForwarding`（CLI 路径）而不是 REST。

## VM id

REST 用**自己的哈希 id**（30 位大写字母数字），和 `inventory.vmls` 里的 `ItemID` **不是一回事**。

```sh
node $SKILL rest vms     # 列出 id + path
```

skill 的 `rest` 子命令**接受 VM 名字**，会自动按 `.vmx` 路径映射到 REST id，不用手工查。

---

## 端点

### VM

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| GET | `/vms` | — | 列出所有 VM：`[{id, path}]` |
| GET | `/vms/{id}` | — | VM 详情（cpu/memory） |
| POST | `/vms` | `{name, parentId}` | **克隆**一台 VM |
| PUT | `/vms/{id}` | `{processors?, memory?}` | 改 CPU/内存 |
| DELETE | `/vms/{id}` | — | 删除 VM |
| GET | `/vms/{id}/power` | — | `{power_state}` |
| PUT | `/vms/{id}/power` | `{operation}` | 见下表 |
| GET | `/vms/{id}/ip` | — | 客户机 IP（需开机） |
| GET | `/vms/{id}/nicips` | — | 网卡 IP 栈信息 |
| GET | `/vms/{id}/params/{name}` | — | 读单个配置项 |
| PUT | `/vms/{id}/configparams` | — | 批量改配置 |
| GET | `/vms/{id}/restrictions` | — | 限制信息 |

`operation` 取值：`on` / `off` / `shutdown` / `suspend` / `pause` / `unpause`

`power_state` 取值：`poweredOn` / `poweredOff` / `paused` / `suspended`

### 网卡

| 方法 | 路径 | Body |
|---|---|---|
| GET | `/vms/{id}/nic` | — |
| POST | `/vms/{id}/nic` | `{type, vmnet}` |
| PUT | `/vms/{id}/nic/{index}` | `{type, vmnet}` |
| DELETE | `/vms/{id}/nic/{index}` | — |

`type`：`custom` / `bridged` / `nat` / `hostonly`
`vmnet`：网络名，**只能用于 `custom`**。给 nat / hostonly 传 `vmnet` 会被拒：
`{"Code":121,"Message":"Redundant parameter: vmnet8 for this operation"}`。

VM 必须关机，否则返回 `Invalid configuration for device '0'`。

返回：`{num, nics: [{index, type, vmnet, macAddress}]}`

### 共享文件夹

| 方法 | 路径 | Body |
|---|---|---|
| GET | `/vms/{id}/sharedfolders` | — |
| POST | `/vms/{id}/sharedfolders` | `{folder_id, host_path, flags}` |
| PUT | `/vms/{id}/sharedfolders/{folderId}` | 同上 |
| DELETE | `/vms/{id}/sharedfolders/{folderId}` | — |

`flags`：整数，**只支持 `4`** = 读写。其它值按只读处理。

### 主机网络

| 方法 | 路径 | Body |
|---|---|---|
| GET | `/vmnet` | — |
| POST | `/vmnets` | `{name, type}` |
| GET | `/vmnet/{vmnet}/portforward` | — |
| PUT | `/vmnet/{vmnet}/portforward/{protocol}/{port}` | `{guestIp, guestPort, desc?}` |
| DELETE | `/vmnet/{vmnet}/portforward/{protocol}/{port}` | — |
| GET | `/vmnet/{vmnet}/mactoip` | — |
| PUT | `/vmnet/{vmnet}/mactoip/{mac}` | `{vmnet, mac, ip}` |

`type`（建网络）：`nat` / `hostOnly`
`protocol`（端口转发）：`tcp` / `udp`

`Network` 返回结构：`{name, type, dhcp, subnet, mask}`，`type` 为 `bridged` / `nat` / `hostOnly`，
`dhcp` 是字符串 `"true"` / `"false"`（**不是布尔**）。

---

## 错误

REST 返回非 2xx 时 body 是：

```json
{ "Code": 106, "Message": "The virtual machine is not powered on" }
```

常见：

| Code | 含义 |
|---|---|
| 106 | 虚拟机没开机 |
| 401 | 凭据不对 |

skill 会把 HTTP 状态码和 body 原样抛出。

## 用法

```sh
export VMWARE_REST_USER=...
export VMWARE_REST_PASSWORD=...

node $SKILL rest status              # 可达性 + 配置状态
node $SKILL rest vms                 # 列出 VM（id + path）
node $SKILL rest power "Win10"       # 用名字即可
node $SKILL rest power-set "Win10" on
node $SKILL rest nic-list "Win10"
node $SKILL rest nic-create "Win10" nat            # nat/hostonly 不要传 vmnet
node $SKILL rest nic-create "Win10" custom vmnet8  # 只有 custom 才要 vmnet
node $SKILL rest folder-create "Win10" share1 "C:/share" --flags 4
node $SKILL rest pf-list vmnet8
node $SKILL rest pf-set vmnet8 tcp 8080 192.168.1.10 80
node $SKILL rest net-list
```

完整子命令：`node $SKILL help rest`。

## 注意

- vmrest 和 Workstation GUI 同时操作同一台 VM 可能产生意外结果（vmrest 启动时自己也会警告）。
- `POST /vms` 的 `parentId` 是**源 VM 的 REST id**。
- 端口转发规则挂在**虚拟网络**（`vmnet1`/`vmnet8`）上，不是 VM 上。
