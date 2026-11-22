# vmrun / vmcli 命令速查

本机 VMware Workstation Pro 26.0.1 实测（`vmrun` version 1.17.0.25688693）。
参数格式全部对着 `vmcli --help` / `vmrun` 的实际输出核对过，不是猜的。

## 路径

```
vmrun.exe   C:\Program Files\VMware\VMware Workstation\vmrun.exe
vmcli.exe   C:\Program Files\VMware\VMware Workstation\vmcli.exe
vmrest.exe  C:\Program Files\VMware\VMware Workstation\vmrest.exe
```

老版本装在 `C:\Program Files (x86)\VMware\VMware Workstation\`。skill 自动探测两个位置；
也可用环境变量 `VMRUN_PATH` / `VMCLI_PATH` / `VMREST_PATH` 指定。

`.vmx` 路径用正斜杠（`K:/VirtualMachines/Win10/Windows 10 x64.vmx`），Windows 上正斜杠和反斜杠都认。

---

## vmrun

```
vmrun -T ws [-gu <guestUser>] [-gp <guestPass>] <command> [params]
```

`-T ws` = Workstation。**认证参数必须在 command 之前。**

### 电源

| 命令 | 参数 |
|---|---|
| `start` | `<vmx> [gui\|nogui]` |
| `stop` | `<vmx> [hard\|soft]` |
| `reset` | `<vmx> [hard\|soft]` |
| `suspend` | `<vmx> [hard\|soft]` |
| `pause` | `<vmx>` |
| `unpause` | `<vmx>` |
| `list` | — （只列**运行中**的 VM） |

### 快照

| 命令 | 参数 |
|---|---|
| `listSnapshots` | `<vmx> [showTree]` |
| `snapshot` | `<vmx> <name>` |
| `deleteSnapshot` | `<vmx> <name> [andDeleteChildren]` |
| `revertToSnapshot` | `<vmx> <name>` |

### 客户机（需 `-gu` / `-gp`）

| 命令 | 参数 |
|---|---|
| `runProgramInGuest` | `<vmx> [-noWait] [-activeWindow] [-interactive] <program> [args...]` |
| `runScriptInGuest` | `<vmx> [-noWait] [-activeWindow] [-interactive] <interpreter> <script>` |
| `listProcessesInGuest` | `<vmx>` |
| `killProcessInGuest` | `<vmx> <pid>` |
| `fileExistsInGuest` | `<vmx> <guestPath>` ← **不存在时退出码 127，不是布尔** |
| `directoryExistsInGuest` | `<vmx> <guestPath>` ← 同上 |
| `listDirectoryInGuest` | `<vmx> <guestPath>` ← 输出 `Directory list: N` + 每行一个名字 |
| `createDirectoryInGuest` | `<vmx> <guestPath>` |
| `deleteDirectoryInGuest` | `<vmx> <guestPath>` |
| `deleteFileInGuest` | `<vmx> <guestPath>` |
| `renameFileInGuest` | `<vmx> <old> <new>` |
| `copyFileFromHostToGuest` | `<vmx> <hostPath> <guestPath>` ← 无大小限制，已存在则覆盖 |
| `copyFileFromGuestToHost` | `<vmx> <guestPath> <hostPath>` ← 同上 |
| `createTempfileInGuest` | `<vmx>` |
| `typeKeystrokesInGuest` | `<vmx> <keystrokes>` |
| `captureScreen` | `<vmx> <hostPath>` ← **需要客户机登录** |
| `connectNamedDevice` | `<vmx> <device>` |
| `disconnectNamedDevice` | `<vmx> <device>` |
| `readVariable` | `<vmx> <runtimeConfig\|guestEnv\|guestVar> <name>` |
| `writeVariable` | `<vmx> <runtimeConfig\|guestEnv\|guestVar> <name> <value>` |

### 共享文件夹 / 主机网络 / 通用

| 命令 | 参数 |
|---|---|
| `enableSharedFolders` | `<vmx> [runtime]` |
| `disableSharedFolders` | `<vmx> [runtime]` |
| `addSharedFolder` | `<vmx> <name> <hostPath>` |
| `removeSharedFolder` | `<vmx> <name>` |
| `setSharedFolderState` | `<vmx> <name> <hostPath> <writable\|readonly>` |
| `listHostNetworks` | — |
| `listPortForwardings` | `<vmnetName>` |
| `setPortForwarding` | `<vmnetName> <proto> <hostPort> <guestIp> <guestPort> [desc]` |
| `deletePortForwarding` | `<vmnetName> <proto> <hostPort>` |
| `getGuestIPAddress` | `<vmx> [-wait]` |
| `checkToolsState` | `<vmx>` |
| `installTools` | `<vmx>` |
| `upgradevm` | `<vmx>` |
| `deleteVM` | `<vmx>` |
| `clone` | `<vmx> <destVmx> <full\|linked> [-snapshot=<name>] [-cloneName=<name>]` |

### 退出码

`0` = 成功，非 `0` = 失败（本机实测 `127`）。错误信息在 stderr，格式 `Error: <message>`。

---

## vmcli

```
vmcli.exe [<vmx location>] <Module> <Command> [<args>]
```

`<vmx location>` 放前放后都行。

### 通用规则（**最容易踩的地方**）

- **绝大多数命令的参数是位置参数**，不是 `-flag value`。
  - `Ethernet SetPresent ethernet0 true` ✅ / `Ethernet SetPresent -i 0 -e true` ❌（`Invalid/unrecognized argument "-e"`）
  - `ConfigParams SetEntry <name> <value>` ✅ / `-k/-v` ❌
  - `Snapshot Take <name>` ✅ / `-n <name>` ❌（`-n` 是 `--native`）
- `Guest` 模块下 **`-p` 是 `--password`**，程序名/路径走位置参数。
- 布尔值写 `true` / `false`（小写）。
- 成功 `0`，失败 `127`，错误在 stderr，前缀 `vmcli.exe:`。

### 模块

**Power** — `query` `Start` `Stop` `Pause` `Unpause` `Reset` `Suspend`
`Start` 可选：`-p` (paused) / `-s` (soft)。

**Chipset** — `query` / `SetVCpuCount <n>` / `SetMemSize <MB>` / `SetCoresPerSocket <n>` / `SetSimultaneousThreads <n>`

**Snapshot** — `query` / `Take <name> [-m] [-d <desc>]` / `Revert <uid>` / `Delete <uid> [-d]` / `Clone <uid> <filePath> <name> [-l] [-o]`

> `Take` 用名字，`Revert`/`Delete`/`Clone` 用 **uid**。名字 → uid 用 `Snapshot query` 查（`snapshots[].displayName` / `.uid`）。
>
> **`Revert` 要求 VM 关机**，开机时报 `VM is in an invalid state (online)`——而这正是最需要回滚的时候。
> 回滚请用 `vmrun revertToSnapshot <vmx> <name>`，它两种电源状态都能用。

**Guest**（全部需 `-u <user> -p <pass>`）
`ls <path> [-r <regexp>] [-i <index>] [-m <max>]` / `mkdir <path> [-parent]` / `rmdir <path> [-r]` / `rm <path>` /
`mv <from> <to> [-o]` / `copyTo <from> <to> [-o]` / `copyFrom <from> <to> [-o]` /
`run <program> [programArgs] [-nw] [-aw] [-i] [-w <dir>] [-e <env>]` / `ps [-pid <pid>] [-f <toml|yaml|json>]` /
`kill <pid>` / `env` / `createTempFile <prefix> <suffix> <dir>` / `createTempDir` / `query` / `toolsproperties`

> `ps -f` 的 help 写 `<0,1,2>`，实际只接受 `toml` / `yaml` / `json`；不给 `-f` 时是 YAML。

> ⚠️ `copyTo` / `copyFrom` **只能传 64KB 以内的文件**。64KB 报 `Unknown error`，再大报
> `VMware Tools are not running in the guest`（假消息）。连续失败几次还会卡死客户机通道，
> 之后所有 guest 操作超时，**只能重启 VM 恢复**。
> 文件传输一律用 vmrun 的 `copyFileFromHostToGuest` / `copyFileFromGuestToHost`。
> 本机实测：100MB 单文件 Windows 客户机约 28 秒、Rocky Linux 客户机约 44 秒；vmrun 支持任意大小，vmcli 只到 64KB。

**MKS** — `query` / `captureScreenshot <filename>` / `sendKeySequence <sequence>` / `sendKeyEvent` /
`SetGuestResolution <w> <h>` / `SetNumDisplays <n>` / `SetVramSize <n>` / `SetGraphicsMemoryKB <n>` /
`SetAccel3d` / `SetRenderer3d` / `SetFullscreenAtPowerOn` / `SetFullScreenOnAllHostDisplays`

> `captureScreenshot` **不需要客户机凭据**——这是截图的首选路径（vmrun 的 `captureScreen` 需要）。
>
> `sendKeySequence` 按**字面文本**输入，`<Enter>` 这类标记不解析，要发真实回车得传 `\r`。
> `\r` 和 `\t` 可用，`\033`（ESC）报 `Unknown error` 并返回 127。文字控制台上不需要客户机凭据，
> 所以 VM 没装 Tools 时这是唯一的输入通道。

**Tools** — `Query` / `Install` / `Upgrade`（`Install`/`Upgrade` 可选 `-c <cmdline>` `-bt <0|1|2>` `-bp <path>`）

**Disk** — `query` / `Create -f <file.vmdk> -s <size> -a <ide|buslogic|lsilogic> -t <0|1|2|3>` /
`Extend <diskLabel> <newNumSectors>` / `SetPresent <diskLabel> <present>` / `Purge <diskLabel>` /
`SetReadOnly` `SetMode` `SetSharing` `SetStartConnected` `ConnectionControl` `Branch` `Move` `SetBackingInfo` …

> `Create` 必须给 `-f`（磁盘文件路径）。`-t` 是**整数**类型：0=单文件可增长，1=分片可增长，2=预分配，3=分片预分配。
> `-s` 必须带单位（`512MB`、`50GB`），裸数字报 `Input Disk Size is not within acceptable limits`。
> `Extend` 的第二个参数是**扇区数**，不是 GB。
>
> **`Create` 只写 `.vmdk`，不挂接**：不补 `<controller>.present`、`sataN:M.fileName` 和设备条目，
> 虚机的 `disks` 数组始终为空，虚机也无法从这块盘启动。`VM Create`（`vmnew`）同样如此。

**Ethernet** — `query` / `SetConnectionType <label> <type>` / `SetPresent <label> <present>` /
`SetStartConnected <label> <connected>` / `SetVirtualDevice <label> <device>` / `SetNetworkName <label> <name>` /
`Purge <label>` / `ConnectionControl <op>` / `MoveDevice` / `SetAddressType` `SetSecurityPolicy` `SetPciSlotNumber` …

> `label` 是 `ethernet0` 这种设备标签（**不是数字索引**），从 `Ethernet query` 的 `devices[].label` 取。

**HGFS** — `query` / `SetEnabled <share> <bool>` / `SetHostPath <share> <path>` / `SetGuestName <share> <name>` /
`SetReadAccess <share> <bool>` / `SetWriteAccess <share> <bool>` / `SetPresent <share> <bool>` /
`SetExpiration` `SetFollowSymlinks` `SetHostDefaultCase` `SetTags`

> **HGFS 的 `<share>` 参数实测有 bug**：传 `sharedFolder0` 或 guestName 都会报
> `Invalid argument: 'sharedFolder0' is not a boolean`——它把第一个位置参数当成布尔值了。
> **改共享文件夹请用 `vmrun`**（`addSharedFolder` / `removeSharedFolder` / `setSharedFolderState`），
> 那边的实现是好的。`vmcli HGFS query` 只能读。
>
> `vmrun addSharedFolder` / `removeSharedFolder` **要求 VM 开机**（关机时报
> `The virtual machine is not powered on`）。
>
> **新加或改过的共享文件夹要重启 VM 才生效**：运行中 `HGFS query` 会返回空列表，`.vmx` 里其实已经写好了。
>
> `removeSharedFolder` 之后 `.vmx` 里会残留 `sharedFolder0.*` 文本，`sharedFolder.maxNum = "0"`
> 表示实际已无生效共享；残留行重启 VMware 后会重写。


**Sata / Nvme / Serial** — `query` / `SetPresent <label> <bool>` / `Purge <label>`
（`label` 形如 `sata0:1`、`nvme0:0`、`serial0:1`）

**VMTemplate** — `Create -p <out.vmtx> -n <name>`（需 vmx 作为第一个参数） / `Deploy -p <file.vmtx>`（无 vmx 参数）

**VM** — `Create -n <name> -d <dir> -g <guestType>` 或 `-c <customGuestType>`

> **`-g` 的 help 里那串数字 id 是过时的**——传 `-g 13` 会报
> `Invalid argument: '13', valid enums are: ...`，实际只收名字（`rhel9-64`、`centos9-64`、`ubuntu-64`、`windows9-64` …）。
> `-c` 收任意 guestOS 名（`rockylinux-64` 等），更通用，本 skill 一律用 `-c`。

**VProbes** — `Query` / `SetEnabled <bool>` / `Load <script>` / `Reset`

**ConfigParams** — `query [-f <toml|yaml|json>]` / `SetEntry <name> <value>`

> `query` 返回 `.vmx` 里的**所有**配置项。含冒号的键会带单引号（`'sata0:0.present': TRUE`），
> 按第一个冒号切分会丢掉整条，解析时要先认引号键。
> **`SetEntry` 是唯一可靠的"写设备条目"手段**：`Ethernet SetPresent`、`Sata SetPresent`
> 在标签不存在时静默无效还返回 0。

### 输出格式

YAML 子集。本 skill 会转成 JSON。表格类输出（`vmrun listHostNetworks` 等）保持原文。

```yaml
PowerState: on
cleanShutdown: false
```

---

## 客户机凭据

两个 CLI 都需要**客户机 OS** 的账号密码（VMware Tools 负责认证）：

- vmrun：`-gu <user> -gp <pass>`，**必须在 command 之前**
- vmcli：`-u <user> -p <pass>`

密码会出现在进程命令行里，所以 skill 用环境变量 `VMWARE_GUEST_USER` / `VMWARE_GUEST_PASS` 传，
不通过 argv 传。
