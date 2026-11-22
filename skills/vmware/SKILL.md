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

**超时**（任何命令都适用）：默认 120 秒，文件传输默认 1 小时。

```sh
node scripts/vmware.js snapshot revert "Windows Server 2012" "系统安装完成" --timeout 600
node scripts/vmware.js guest exec "Ubuntu 22 x64" "make -j4" --timeout 0     # 0 = 不限时
```

客户机命令里若真的要出现字面量 `--timeout`，用 `--` 隔开：`guest exec vm -- slowtool --timeout 5`。

## Windows 上先设 MSYS_NO_PATHCONV=1

在 **Git Bash / MSYS2** 里跑（这是 Claude Code 在 Windows 上的默认 shell），MSYS 会把 `/c`、`/tmp` 这类参数改写成 `C:/`、`C:\Program Files\Git\tmp`：

```sh
export MSYS_NO_PATHCONV=1
node scripts/vmware.js guest exec "Win10" "dir C:\\"
```

不设的后果很隐蔽：命令被改写成 `C:/ echo ...`，`cmd` 报一个看不懂的错，或者干脆挂到超时。主机路径再交给客户机时用 `cygpath -w` 转成 `C:\...` 形式。PowerShell / cmd 没有这个问题，只是别用单引号包 Windows 路径。

## 三层能力，怎么选

| 层 | 工具 | 覆盖范围 | 前置条件 |
|---|---|---|---|
| **主力** | `vmrun` | 电源、快照、客户机文件/进程、共享文件夹、克隆、主机网络、端口转发 | 无 |
| **主力** | `vmcli` | 芯片组(CPU/内存)、磁盘、网卡、SATA/NVMe/串口、HGFS、Tools、MKS、模板 | 无 |
| **补充** | `vmrest` (REST API) | 新增网卡、新建虚拟网络、克隆 VM、改 CPU/内存 | 需手动启动 vmrest |

**能用 CLI 就别用 REST。**

## 分组速查

| 分组 | 干什么 |
|---|---|
| `vm` | `list` 列表 / `info` 全量配置 / `running` 运行中 |
| `power` | `status` `start` `stop` `reset` `suspend` `pause` `unpause` |
| `snapshot` | `list` `take` `revert` `delete` `clone`（**按名字操作**，自动查 uid） |
| `guest` | 客户机内 `ls` `mkdir` `rm` `mv` `copy-to` `copy-from` `put-dir` `get-dir` `exec` `run` `script` `ps` `kill` `exists` `dir-exists` `ready` `env` |
| `shared` | 共享文件夹 `list` `add` `remove` `set` `enable` `disable` |
| `chipset` | `query` `cpu` `memory` `cores` |
| `config` | 读写 `.vmx` 配置项 `get` `set` |
| `disk` | `list` `create` `extend` `remove` |
| `nic` | `list` `set-type` `set-present` `set-connected` `set-device` `set-network` `purge` `add` |
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

口令不会出现在任何输出的命令行里（超时报错会把 `-gp` 后面的值打成 `***`）。

## 客户机文件与命令

| 想做的事 | 命令 |
|---|---|
| 传单个文件进去 / 拿出来 | `guest copy-to` / `guest copy-from` |
| 传整个目录树 | `guest put-dir` / `guest get-dir` |
| **拿命令输出** | `guest exec` |
| 只把程序拉起来，不等结果 | `guest run` / `guest script` |
| 判断路径在不在 | `guest exists` / `guest dir-exists` |
| 等客户机真正可用 | `guest ready` |

**`guest exec` 是跑命令的默认选择**——它把 stdout+stderr 带回来，并把客户机的退出码变成脚本的退出码：

```sh
node scripts/vmware.js guest exec "Win10" "dir C:\\Windows"
node scripts/vmware.js guest exec "Ubuntu 22 x64" "systemctl is-active nginx"   # 退出码原样透传
```

实现上会在客户机的 `C:\Windows\Temp`（Linux 为 `/tmp`）落一个临时脚本和日志，跑完删除。所以**命令里可以自由使用 `>` `|` `&&` 和引号**——它被当成脚本执行，不经过任何一层的引号重写。

`guest run` 是 vmrun 的直通，**不返回输出**，只适合交互式程序或已经自己写日志的进程。
`guest script` 把脚本体写成客户机内的临时文件再执行，同样不返回输出；Windows 客户机上统一用 `cmd.exe /c` 跑 `.bat`。

**`exists` 是查询不是断言**：路径不存在打印 `false` 并正常退出 0。

```sh
if [ "$(node scripts/vmware.js guest exists "Win10" 'C:\setup.exe')" = "true" ]; then ...; fi
```

**`guest ready` 用来等客户机真正可用**：

```sh
node scripts/vmware.js guest ready "Win10" --timeout 300
# { "tools": "running", "ready": true, "elapsedMs": 41250 }
```

必须等 `ready: true`，不能只看 `tools status`——Tools 报 `running` 而客户机通道卡死时，所有 guest 操作都会静默超时。

## 控制台：截图与按键

`screen` 走 `vmcli MKS`，**不需要客户机凭据**，在文字控制台上照样能用。

```sh
node scripts/vmware.js screen capture "Win10" "C:/shots/a.png"
node scripts/vmware.js screen keys "Rocky9" "root<Enter>"
node scripts/vmware.js screen keys "Rocky9" "$VMWARE_GUEST_PASS<Enter>"
```

口令从环境变量展开，别写进命令行（会进 shell history）。

按键是**字面文本**，只有这几个标记会被翻译：`<Enter>` `<Tab>` `<Space>`。方向键、`<Esc>` 等控制字符 MKS 不接受，会自动回退到 `vmrun typeKeystrokesInGuest`（那条路在文字控制台上常报
`Insufficient permissions in the host operating system`）。

所以**客户机没装 Tools 时，`screen capture` + `screen keys` 是唯一的交互通道**——可以先用它登录、把网络配好，再转 SSH 或装 Tools。截图后立刻看一眼，别盲打。

## REST API（可选）

只有这几件事 CLI 做不到，必须走 REST：

- `nic add <vm> <type> [vmnet]` —— 增加一块网卡（`vmnet` 只对 `custom` 有效，nat/hostonly 传了会报 `Redundant parameter`；VM 需关机）
- `net create` —— 新建虚拟网络
- `rest vm-create` —— 克隆一台 VM
- `rest vm-update` —— 改 CPU/内存（VM 需关机）

**vmnet 层写操作 REST 一律 403**（端口转发、新建虚拟网络、mactoip），即使以 Administrator 运行 vmrest。这类改动走 CLI：`vmrun setPortForwarding`。详见 [references/rest-api.md](references/rest-api.md)。

启动 vmrest（**首次需要配置凭据**，交互式，密码复杂度要求：≥8 位、小写、数字、特殊字符）：

```sh
"C:/Program Files/VMware/VMware Workstation/vmrest.exe" -C    # 一次性配置
"C:/Program Files/VMware/VMware Workstation/vmrest.exe"       # 启动服务
```

之后设好环境变量即可：

```sh
export VMWARE_REST_USER=...
export VMWARE_REST_PASSWORD=...
node scripts/vmware.js rest status          # 确认可达
```

**两类凭据的变量名不要混**：

| 变量 | 用途 |
|---|---|
| `VMWARE_GUEST_USER` / `VMWARE_GUEST_PASS` | 客户机 OS 的登录账号（`guest` 分组） |
| `VMWARE_REST_USER` / `VMWARE_REST_PASSWORD` | vmrest 的 HTTP Basic 认证（`rest` 分组） |
| `VMWARE_REST_HOST` / `VMWARE_REST_PORT` | vmrest 地址，默认 `127.0.0.1:8697` |

不读 `VMWARE_USERNAME` / `VMWARE_PASSWORD` 这类泛名。REST 用自己的 VM id（哈希串），但 `rest` / `nic` 子命令**接受 VM 名字**，会自动映射。

## 行为约定

- **只读命令随便跑**：`list` `status` `query` `info`。
- **写操作先确认**：`power stop/reset` `snapshot delete` `snapshot revert` `clone` `vmnew` `disk create/extend/remove` `nic purge` `config set` 会丢数据或改机器状态——执行前跟用户确认要动哪台、做什么。
- **快照名不能含 `/`**（VMware 的路径分隔符），也别用空格。
- **`snapshot delete` 默认不删子快照**，要连子树一起删加 `--children`。
- **`snapshot revert` 在开机状态下也能用**（走 vmrun，不用 vmcli）。
- **`power stop --hard` 等于拔电源**，客户机可能丢数据；默认是 `soft`。
- **`power start` 默认开 GUI**（`--nogui` 后台跑）。
- **改 CPU/内存必须关机**：`chipset cpu|memory|cores` 走热插拔通道。
  想为下次启动改配置用 `config set <vm> memsize <MB>`。
- **`disk create <vm> <file> <size>` 的 size 必须带单位**（`512MB`、`50GB`），裸数字 vmcli 会拒绝。
  只给文件名时落在 `.vmx` 旁边。默认自动挂接，`--no-attach` 只生成裸 vmdk。
  `disk remove` 默认只摘除设备，加 `--delete-file` 连文件一起删。
- **`vmnew <name> <dir> [--guest <guestos>]`**：`--guest` 收 VMware guestOS 名（`rhel9-64`、`rockylinux-64`、`ubuntu-64`、`windows9-64`），默认 `other6xlinux-64`。vmcli `--help` 里那串数字 id 是过时的，传数字会被拒。
- **`template deploy` 只接受 `-p <template.vmtx>`**：没有目标目录与名字参数，虚机建在模板旁边、沿用模板名。
- **`snapshot clone` / `clone` 的目标目录必须已存在**，否则报 `Could not find the file`。

## 已知坑

1. **`vmcli` 的参数基本是位置参数，不是开关。** 按真实的 `vmcli --help` 对过一遍：
   - `Ethernet SetPresent ethernet0 true`（不是 `-i 0 -e true`）
   - `Snapshot Take <name>`（`-n` 是 `--native`，不是 name）
   - `ConfigParams SetEntry <name> <value>`（不是 `-k/-v`）
   - `Guest ps -f` 的 help 写 `<0,1,2>`，实际只收 `toml|yaml|json`
   - `Disk Create -f <file.vmdk> -s <size> -a <adapter> -t <0-3>`（`-t` 是 int，不是 `"scsi"`）
2. **vmcli 成功返回 0，失败返回 127**，错误信息在 stderr。个别命令会写 stderr 却仍返回 0。
3. **vmcli 输出是 YAML 子集**，已转成 JSON；表格类输出（`net list`）保持原样。key 可能带引号且含冒号（`'sata0:0.present': TRUE`），解析器已处理。
4. **两个 CLI 路径可能不同**：`C:\Program Files\VMware\...` 或 `(x86)`。自动探测，也可用 `VMRUN_PATH` / `VMCLI_PATH` 覆盖。
5. **`.vmx` 路径统一用正斜杠**，Windows 上两边都认。
6. **vmrest 要单独起**，不像 CLI 是无状态的。
7. **改共享文件夹只能用 `vmrun`**：`vmcli HGFS Set*` 把第一个位置参数当布尔值。`vmcli HGFS query` 只能读。
   **新加/启停共享文件夹要重启 VM 才生效**，运行中查询会显示空列表。
8. **`shared remove` 之后 `.vmx` 会残留 `sharedFolder0.*` 文本**——`sharedFolder.maxNum = "0"` 说明实际已无生效共享。
9. **`vmcli Guest copyTo/copyFrom` 只能传 64KB 以内的文件**，超过报 `Unknown error` 或假的 `VMware Tools are not running`。连续失败还会把客户机通道卡死，之后所有 guest 操作超时，只有重启 VM 能恢复。本 skill 的文件传输全部走 `vmrun`（实测 100MB 约 44 秒）。
10. **`vmrun` 会给含空格的参数重新加引号**，`cmd.exe` 只剥掉一个，命令末尾多出 `"`。所以 `guest exec` 把命令写成脚本文件再执行。
11. **`runProgramInGuest` 的 `-interactive` 在 Windows 客户机上经常失败**（`The specified guest user does not match the user currently logged in interactively`）。Administrator 已交互登录时不要加。
12. **客户机通道卡死时 `tools status` 仍报 running。** 判断能否操作用 `guest ready`。真卡死了只能 `power stop --hard` 再起来。
13. **`Ethernet SetPresent` / `Sata SetPresent` 在设备标签尚不存在时静默无效**，还返回成功。所以 `nic set-present` / `set-connected` / `disk create` 的挂接都改写成 `ConfigParams SetEntry`。
14. **`vmcli Disk Create` 只写 vmdk，不挂接**；`VM Create`（vmnew）同样只写 vmdk 不写磁盘条目，建出来不能启动。两处本 skill 都补了控制器与设备条目。
15. **`vmnew` / `snapshot clone` 建的虚机不写进 `inventory.vmls`**，按名字找不到。用 `.vmx` 路径操作，或先在 Workstation 里打开一次。
16. **`net portforward-set/delete` 可能报 `Failed to refresh NAT configuration`**，即使 `vmnetnat.conf` 已更新。原生 vmrun 一样失败（需重启 `VMware NAT Service`），不是本 skill 的问题。
17. **不要用 `grep -v` 过滤 `.vmx` 来"清理"设备**：会顺手删掉引导盘条目，虚机变成 `Operating System not found`。要改设备用 `disk remove` / `config set`。

## 深入

- [vmrun / vmcli 命令速查](references/cli-reference.md) —— 原始命令与参数对照
- [REST API 参考](references/rest-api.md) —— 端点、body 格式、字段说明
