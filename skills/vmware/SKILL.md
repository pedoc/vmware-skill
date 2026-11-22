---
name: vmware
description: "控制本机 VMware Workstation Pro 虚拟机：电源开关/暂停/挂起、快照、共享文件夹、客户机内文件与进程操作、CPU/内存/磁盘/网卡/芯片组/串口/SATA/NVMe 配置、主机端口转发、模板、克隆、截图。通过 VMware 自带的 vmrun.exe / vmcli.exe 完成，无需 MCP server，无需常驻进程。当用户提到 VMware、虚拟机、vmrun、vmcli、vmrest、vmx、vmdk、快照、Workstation、虚机开关机/改配置时使用。"
---

# VMware Workstation 虚拟机控制

用 VMware 自带的 `vmrun.exe` / `vmcli.exe` 直接控制虚拟机。**没有 MCP server，没有常驻进程**——命令跑完就退出。

## 快速开始

脚本在本 skill 目录下的 `scripts/vmware.js`。**不要硬编码路径**——本 skill 可能装在
`~/.claude/skills/`、`.agents/skills/`、或项目里 `.claude/skills/`。用相对于本文件的路径：

```sh
# 在 skill 目录下执行
node scripts/vmware.js vm list --power        # 所有已注册虚拟机 + 电源状态
node scripts/vmware.js power status "Ubuntu 22 x64"
node scripts/vmware.js snapshot list "Windows Server 2012"
node scripts/vmware.js help <group>            # 每个分组的完整子命令
```

**虚拟机用名字或 `.vmx` 路径指代**，两者都行：

```sh
node scripts/vmware.js power status "Win10"
node scripts/vmware.js power status "K:/VirtualMachines/Win10/Windows 10 x64.vmx"
```

名字解析走 VMware 自己的 `inventory.vmls`，**不需要 vmrest**。

## 三层能力，怎么选

| 层 | 工具 | 覆盖范围 | 前置条件 |
|---|---|---|---|
| **主力** | `vmrun` | 电源、快照、客户机文件/进程、共享文件夹、克隆、主机网络、端口转发 | 无 |
| **主力** | `vmcli` | 芯片组(CPU/内存)、磁盘、网卡、SATA/NVMe/串口、HGFS、Tools、MKS、模板 | 无 |
| **补充** | `vmrest` (REST API) | 新增网卡、新建虚拟网络、克隆 VM、改 CPU/内存 | 需手动启动 vmrest |

**能用 CLI 就别用 REST。** REST 只在 CLI 确实做不到时用（见下）。

## 分组速查

| 分组 | 干什么 |
|---|---|
| `vm` | `list` 列表 / `info` 全量配置 / `running` 运行中 |
| `power` | `status` `start` `stop` `reset` `suspend` `pause` `unpause` |
| `snapshot` | `list` `take` `revert` `delete` `clone`（**按名字操作**，自动查 uid） |
| `guest` | 客户机内 `ls` `mkdir` `rm` `mv` `copy-to` `copy-from` `run` `script` `ps` `kill` `exists` `env` |
| `shared` | 共享文件夹 `list` `add` `remove` `set` `enable` `disable` |
| `chipset` | `query` `cpu` `memory` `cores` |
| `config` | 读写 `.vmx` 配置项 `get` `set` |
| `disk` | `list` `create` `extend` |
| `nic` | `list` `set-type` `set-present` `set-device` `set-network` `purge` `add` |
| `net` | 主机虚拟网络 `list` `portforward-list/set/delete` `create` |
| `tools` | `status` `install` `upgrade` |
| `screen` | `capture` 截图（**不需要客户机密码**）/ `keys` 模拟按键 |
| `device` | `connect` `disconnect` 命名设备 |
| `vars` | `read` `write` 变量（runtimeConfig/guestEnv/guestVar） |
| `template` | `create` `deploy` 模板 |
| `clone` / `vmnew` | 克隆 / 新建虚拟机 |
| `rest` | REST API 原始入口 |
| `raw` | 逃生口：`raw vmcli ...` / `raw vmrun ...` 直接调原始命令 |

每个分组的完整参数：`node scripts/vmware.js help <group>`。

## 客户机操作需要凭据

`guest` 分组里所有命令都需要客户机 OS 的账号密码，**通过环境变量传，不要写进命令行**（命令行会进进程列表和 shell history）：

```sh
export VMWARE_GUEST_USER=root
export VMWARE_GUEST_PASS='...'
node scripts/vmware.js guest ps "Ubuntu 22 x64"
```

没设就直接报错退出，不会瞎猜。凭据需要客户机里装了并运行 VMware Tools。

**例外**：`screen capture` 走 `vmcli MKS`，不需要密码。

## REST API（可选）

只有这几件事 CLI 做不到，必须走 REST：

- `nic add` —— 增加一块网卡
- `net create` —— 新建虚拟网络
- `rest vm-create` —— 克隆一台 VM
- `rest vm-update` —— 改 CPU/内存

启动 vmrest（**首次需要配置凭据**，交互式，密码复杂度要求：≥8 位、小写、数字、特殊字符）：

```sh
"C:/Program Files/VMware/VMware Workstation/vmrest.exe" -C    # 一次性配置
"C:/Program Files/VMware/VMware Workstation/vmrest.exe"       # 启动服务
```

之后设好环境变量即可：

```sh
export VMWARE_USERNAME=...
export VMWARE_PASSWORD=...
node scripts/vmware.js rest status          # 确认可达
```

REST 用自己的 VM id（哈希串），但 `rest` 子命令**接受 VM 名字**，会自动映射。

## 行为约定

- **只读命令随便跑**：`list` `status` `query` `info`。
- **写操作先确认**：`power stop/reset` `snapshot delete` `snapshot revert` `clone` `vmnew` `disk create/extend` `nic purge` `config set` 会丢数据或改机器状态——执行前跟用户确认要动哪台、做什么。
- **快照名不能含 `/`**（VMware 的路径分隔符），也别用空格。
- **`snapshot delete` 默认不删子快照**，要连子树一起删加 `--children`。
- **`power stop --hard` 等于拔电源**，客户机可能丢数据；默认是 `soft`。
- **`power start` 默认开 GUI**（`--nogui` 后台跑）。
- 客户机操作超时是正常的（等 Tools 握手），失败会返回 VMware 原始错误。

## 已知坑（照着 README 走会踩）

1. **`vmcli` 的参数基本是位置参数，不是 `-i/-e` 那种开关。** 本 skill 已经按真实的 `vmcli --help` 对过一遍：
   - `Ethernet SetPresent ethernet0 true`（不是 `-i 0 -e true`）
   - `Snapshot Take <name>`（`-n` 是 `--native`，不是 name）
   - `ConfigParams SetEntry <name> <value>`（不是 `-k/-v`）
   - `Guest run` 的 `-p` 是**密码**，程序名是位置参数
   - `Disk Create -f <file.vmdk> -s <size> -a <adapter> -t <0-3>`（`-t` 是 int，不是 `"scsi"`）
2. **vmcli 成功返回 0，失败返回 127**，错误信息在 stderr。
3. **vmcli 输出是 YAML 子集**，已转成 JSON；表格类输出（`net list`）保持原样。
4. **两个 CLI 的路径都可能不同**：本机是 `C:\Program Files\VMware\...`（不是 `(x86)`）。skill 自动探测，也可用 `VMRUN_PATH` / `VMCLI_PATH` 覆盖。
5. **`.vmx` 路径统一用正斜杠**，Windows 上两边都认。
6. **vmrest 要单独起**，不像 CLI 是无状态的。
7. **改共享文件夹只能用 `vmrun`**：`vmcli HGFS Set*` 的 `<share>` 参数有 bug（把第一个位置参数当布尔值，
   报 `Invalid argument: '...' is not a boolean`）。`vmcli HGFS query` 只能读。
8. **`shared remove` 之后 `.vmx` 会残留 `sharedFolder0.*` 文本**——`sharedFolder.maxNum = "0"` 说明
   实际已无生效共享，但残留行需要手动删或重启 VMware 让它重写。

## 深入

- [vmrun / vmcli 命令速查](references/cli-reference.md) —— 原始命令与参数对照
- [REST API 参考](references/rest-api.md) —— 端点、body 格式、字段说明
