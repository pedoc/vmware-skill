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

不设的后果很隐蔽：命令被改写成 `C:/ echo ...`，`cmd` 报一个看不懂的错，或者干脆挂到超时。主机路径再交给客户机时用 `cygpath -w` 转成 `C:\...` 形式。

PowerShell / cmd 里没有这个问题，只是别用单引号包 Windows 路径。

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
| `guest` | 客户机内 `ls` `mkdir` `rm` `mv` `copy-to` `copy-from` `put-dir` `get-dir` `exec` `run` `script` `ps` `kill` `exists` `dir-exists` `ready` `env` |
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

口令不会出现在任何输出的命令行里（超时报错会把 `-gp` 后面的值打成 `***`）。

## 客户机文件与命令

| 想做的事 | 命令 |
|---|---|
| 传单个文件进去 / 拿出来 | `guest copy-to` / `guest copy-from` |
| 传整个目录树 | `guest put-dir` / `guest get-dir` |
| **拿命令输出** | `guest exec` |
| 只把程序拉起来，不等结果 | `guest run` / `guest script` |
| 判断路径在不在 | `guest exists` / `guest dir-exists` |

**`guest exec` 是跑命令的默认选择**——它把 stdout+stderr 带回来，并把客户机的退出码变成脚本的退出码：

```sh
node scripts/vmware.js guest exec "Win10" "dir C:\\Windows"
node scripts/vmware.js guest exec "Ubuntu 22 x64" "systemctl is-active nginx"   # 退出码原样透传
```

实现上会在客户机的 `C:\Windows\Temp`（Linux 为 `/tmp`）落一个临时脚本和日志，跑完删除。所以**命令里可以自由使用 `>` `|` `&&` 和引号**——它被当成脚本执行，不经过任何一层的引号重写。

`guest run` 是 vmrun 的直通，**不返回输出**，只适合交互式程序或已经自己写日志的进程。

`guest script <vm> <interpreter> <script内容>` 把脚本体写成客户机内的临时文件再执行，
**不经过 vmrun 的 `runScriptInGuest`**——后者在 Windows 客户机上会无限挂起
（实测 `runScriptInGuest <vmx> cmd.exe "echo hi"` 永不返回，换成 `cmd.exe /c` 报
`A file was not found`）。Windows 客户机上解释器参数会被忽略、统一用 `cmd.exe /c`
执行 .bat，因为 .bat 只能由 cmd 运行。同样不返回脚本输出，要拿输出用 `guest exec`。

**`exists` 是查询不是断言**：路径不存在打印 `false` 并正常退出 0，只有客户机本身不可用才报错。

```sh
if [ "$(node scripts/vmware.js guest exists "Win10" 'C:\setup.exe')" = "true" ]; then ...; fi
```

**`guest ready` 用来等客户机真正可用**：

```sh
node scripts/vmware.js guest ready "Win10" --timeout 300
# { "tools": "running", "ready": true, "elapsedMs": 41250 }
```

必须等 `ready: true`，不能只看 `tools status`。Tools 报 `running` 但客户机通道卡死时，所有 guest 操作都会静默超时——`ready` 会做一次真实往返探测，正好能识别这种状态。

## REST API（可选）

只有这几件事 CLI 做不到，必须走 REST：

- `nic add` —— 增加一块网卡
- `net create` —— 新建虚拟网络
- `rest vm-create` —— 克隆一台 VM
- `rest vm-update` —— 改 CPU/内存（VM 需关机）

**注意 vmnet 层写操作 REST 一律 403**（端口转发、新建虚拟网络、mactoip），
即使以 Administrator 运行 vmrest。这类改动请走 CLI：`vmrun setPortForwarding`。
详见 [references/rest-api.md](references/rest-api.md)。

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

不读 `VMWARE_USERNAME` / `VMWARE_PASSWORD` 这类泛名——它们既容易和别的工具撞，
也看不出指的是客户机还是 REST。

REST 用自己的 VM id（哈希串），但 `rest` 子命令**接受 VM 名字**，会自动映射。

## 行为约定

- **只读命令随便跑**：`list` `status` `query` `info`。
- **写操作先确认**：`power stop/reset` `snapshot delete` `snapshot revert` `clone` `vmnew` `disk create/extend` `nic purge` `config set` 会丢数据或改机器状态——执行前跟用户确认要动哪台、做什么。
- **快照名不能含 `/`**（VMware 的路径分隔符），也别用空格。
- **`snapshot delete` 默认不删子快照**，要连子树一起删加 `--children`。
- **`power stop --hard` 等于拔电源**，客户机可能丢数据；默认是 `soft`。
- **`power start` 默认开 GUI**（`--nogui` 后台跑）。
- 客户机操作超时是正常的（等 Tools 握手），失败会返回 VMware 原始错误。
- **改 CPU/内存必须关机**：`chipset cpu|memory|cores` 走热插拔通道，开机的 VM 会直接报错。
  想为下次启动改配置用 `config set <vm> memsize <MB>`。
- **`template deploy` 只接受 `-p <template.vmtx>`**：vmcli 没有目标目录与名字参数，
  虚机就建在模板旁边、沿用模板名。要放别处先把模板拷过去。
- **`snapshot clone` / `clone` 的目标目录必须已存在**，否则报 `Could not find the file`。
- **`disk create` 默认会自动挂接**（写 `sataN:M.fileName` 并补控制器），
  加 `--no-attach` 则只生成裸 vmdk 文件。

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
9. **`vmcli Guest copyTo/copyFrom` 只能传 64KB 以内的文件**，超过就报 `Unknown error` 或
   `VMware Tools are not running in the guest`（后者是假消息，Tools 好着呢）。更糟的是连续失败几次
   会把客户机通道卡死，之后**所有** guest 操作都超时，只有重启 VM 能恢复。
   本 skill 的文件传输因此全部走 `vmrun`，不要绕回去用 vmcli。
10. **`vmrun` 会给含空格的参数重新加引号**，`cmd.exe` 又只剥掉其中一个，结果命令末尾会多出一个
   `"`。所以 `guest exec` 把命令写成脚本文件再执行，不内联传参。
11. **`runProgramInGuest` 的 `-interactive` 在 Windows 客户机上经常失败**：报
   `The specified guest user does not match the user currently logged in interactively`。
   Administrator 已交互登录时不要加这个 flag。
12. **客户机通道卡死时，`tools status` 仍然报 running。** 判断能否操作要用 `guest ready`
   （会做一次真实往返），不要用 `tools status`。真卡死了只能 `power stop --hard` 再起来。
13. **`Ethernet SetPresent` 在设备标签尚不存在时静默无效**，还返回成功。`nic set-present` /
    `set-connected` 因此改写成 `ConfigParams SetEntry <label>.present <bool>`。
14. **`vmcli Disk Create` 只写 vmdk 文件，不挂接**——不补 `sataN:M.fileName` 与控制器，
    虚机里的 `disks` 始终是空数组，而命令照样返回成功。
15. **`vmnew` / `snapshot clone` 建的虚机不写进 `inventory.vmls`**，按名字找不到。
    用 `.vmx` 路径操作，或先在 Workstation 里打开一次。
16. **`net portforward-set/delete` 可能报 `Failed to refresh NAT configuration`**，即使
    `vmnetnat.conf` 已正确更新。原生 vmrun 一样失败（`VMware NAT Service` 需要重启），
    不是本 skill 的问题。

## 深入

- [vmrun / vmcli 命令速查](references/cli-reference.md) —— 原始命令与参数对照
- [REST API 参考](references/rest-api.md) —— 端点、body 格式、字段说明
