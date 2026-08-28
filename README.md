# FluxDown Cover for HarmonyOS (ArkTS)

This is a **port of [FluxDown](https://github.com/zerx-lab/FluxDown)** — the Rust + Flutter
multi-protocol download manager — to **HarmonyOS NEXT**, written in **ArkTS / ArkUI**
(the native HarmonyOS language), as a Stage-model DevEco Studio project. Named **FluxDown Cover**.

> Original FluxDown = Rust engine (HTTP/FTP/BitTorrent/eD2K/HLS/DASH) + Flutter UI + Rinf FFI +
> browser extension + MCP server. This port re-implements the experience natively for phones
> (target device read via `hdc`: **HUAWEI Mate 60 Pro** UDID `FMR0224424008138`,
> **HarmonyOS NEXT 6.1.1.120 / API 24**).

---

## What is implemented

| Feature | Status | Notes |
|---|---|---|
| Multi-threaded HTTP/HTTPS download | ✅ Full | Dynamic segmentation, `Range` requests, concurrent streams via `requestInStream` |
| Resume / "resume anywhere" | ✅ Full | Per-segment progress persisted to SQLite; survives app restart |
| HLS (`.m3u8`) download | ✅ Full | Playlist parse + sequential `.ts` append; master→variant follow; **清晰度选择** (probe master playlist variants, pick a quality) |
| DASH (MPD) download | ✅ Implemented | Media segment extraction + sequential append |
| FTP download (passive) | ✅ Implemented | Anonymous PASV `RETR`; **validate on-device** (socket timing) |
| SFTP download | ✅ Implemented | Basic SFTP over SSH transport (best-effort, validate on-device) |
| eD2K (eMule) network | ✅ Implemented | eD2K link parse + Kad/ed2k server protocol (best-effort) |
| Thunder / FlashGet / QQDL links | ✅ Implemented | `thunder://`, `flashget://`, `qqdl://` decode → underlying URL |
| BitTorrent P2P download | ✅ Implemented | `.torrent` + magnet links; **DHT** bootstrap/announce, tracker announce (UDP+HTTP), peer wire protocol, piece assembly, SHA-1 verification |
| BT seeding (做种) | ✅ Implemented | PeerServer inbound, UPnP port mapping, SeedingManager with ratio/time/inactive limits, per-task 开始/停止做种 |
| SHA-256 integrity check | ✅ Full | Runs off the UI thread in **TaskPool** (`@Concurrent` + `cryptoFramework`) |
| SQLite persistence | ✅ Full | `@ohos.data.relationalStore` (ArkData); tasks, queues, categories, RSS, BT settings |
| Three-pane ArkUI | ✅ Full | Master/detail `Navigation` + settings; light/dark themes; 10 accent color schemes |
| MCP server (AI-agent) | ✅ Implemented | Local HTTP JSON-RPC on `127.0.0.1:17800`, Bearer-auth, 5 tools |
| Save to public **Download** dir | ✅ Full | `DocumentViewPicker` DOWNLOAD mode — manual "导出" button + optional auto-export toggle |
| **搜索与筛选** | ✅ Full | 关键词搜索（文件名/链接）+ 状态细分筛选（全部/排队/下载中/暂停/完成/错误）+ 分类筛选 |
| **任务管理** | ✅ Full | 重命名、移动到目录、重新检查、清理失效任务、批量删除（保留/删除文件二选一） |
| **自定义分类** | ✅ Full | 名称 + 扩展名规则 + 独立保存目录 + 自动归类 + 优先级排序 |
| **下载队列** | ✅ Full | 并发上限、优先级、自动开始、队列级限速、**每日定时启停窗口** |
| **完成通知** | ✅ Full | 系统通知（可开关） |
| **RSS 订阅增强** | ✅ Full | 包含/排除关键词、抓取间隔、自动下载开关、体积上下限、目标队列、立即检查 |
| **下载策略** | ✅ Full | 失败自动重试（次数/间隔）、文件已存在行为（覆盖/重命名/跳过）、文件丢失行为（保留/移除）、服务器文件时间（Last-Modified→mtime） |
| **BT 设置面板** | ✅ Full | DHT/UPnP、监听端口范围、自动做种、做种停止条件（分享率/时长/不活跃/并发/上传限速/条件组合），保存即热生效 |
| **队列高级设置** | ✅ Full | 队列默认线程数/User-Agent/保存目录（任务创建时继承）+ 队列顺序调整（上移/下移） |
| **任务详情信息** | ✅ Full | 分类/优先级/所属队列/线程数/任务限速/保存位置/校验开关/HTTP 认证等完整字段 |
| **TXT 批量导入** | ✅ Full | 文件选择器选 .txt，每行一个链接追加到批量下载 |
| **跟随系统主题** | ✅ Full | 浅色/深色/跟随系统三模式（检测系统亮暗并自动切换） |
| **多终端适配** | ✅ Full | deviceTypes 支持 phone/tablet/2in1；状态筛选 chips 窄屏横向滚动 |
| **响应式窗口** | ✅ Full | 窗口尺寸实时监听（onAreaChange）→ 详情/设置/新建/统计/关于内容区在宽窗（>900vp）自动限宽居中，200ms 平滑过渡；手机全宽 |
| **新建下载输入区** | ✅ Full | 卡片式链接输入框：协议图标随输入实时变色、聚焦描边+阴影高亮、一键粘贴（剪贴板）、清除按钮 |
| **统一页眉 UI** | ✅ Full | 主界面与全部 5 个子页面页眉统一：高 56、18 Bold 标题 + 主题色图标、底部 1px 分隔线、同背景色 |
| **深色模式配色统一** | ✅ Full | 原封不动移植 FluxDown 官方 Default Dark（Apple 风格深灰）：背景 #1C1C1E / 卡片 #2C2C2E / 次级面 #3A3A3C / 边框 #48484A / 主文字 #F5F5F7 / 次级 #A1A1A6；全局移除 15 处毛玻璃样式，卡片统一纯色，上下一致 |
| Browser extension | ⛔ Out of scope | Original is a separate WXT/TS extension; OHOS side hooks documented below |

---

## Project structure

```
FluxDownCoverOHOS/
├── build-profile.json5            # product: API 24, runtimeOS HarmonyOS
├── oh-package.json5
├── AppScope/                      # app-level bundle name, icon, label
└── fluxdowncover/src/main/
    ├── module.json5              # abilities + permissions (INTERNET, GET_NETWORK_INFO, KEEP_BACKGROUND_RUNNING)
    ├── resources/                # strings, colors, icons, pages profile
    └── ets/
        ├── entryability/EntryAbility.ts     # boot: init DB + engine + deep-link handling
        ├── model/                # DownloadTask (@ObservedV2), TaskStatus, ProtocolType, DownloadQueue, DownloadCategory, RssSubscription
        ├── engine/
        │   ├── DownloadEngine.ts # orchestrator: probe→segment→resume→verify + rename/move/recheck/cleanup
        │   ├── BtEngine.ts       # BitTorrent orchestrator: DHT / PeerServer / UPnP / tracker / seeding
        │   ├── HashTask.ets      # @Concurrent SHA-256 (TaskPool)
        │   ├── EngineHooks.ts / types.ts
        │   └── protocols/
        │       ├── HlsProtocol.ts   # parse + append .ts + variant quality probe
        │       ├── DashProtocol.ts  # MPD segment download
        │       ├── FtpProtocol.ts   # passive-mode client (@ohos.net.socket)
        │       ├── SftpProtocol.ts  # SFTP (best-effort)
        │       ├── Ed2kProtocol.ts  # eD2K + ed2k/ (Kad helpers)
        │       ├── ThunderProtocol.ts # thunder/flashget/qqdl decode
        │       ├── BittorrentProtocol.ts
        │       └── bittorrent/     # TorrentMeta, MagnetLink, MetadataExchange, PeerWire, PieceManager,
        │                           # Dht, Tracker, UdpTracker, TrackerManager, PeerServer, UpnpPortMapper, SeedingManager
        ├── store/                # DatabaseManager (RDB) + TaskRepository + QueueStore + CategoryStore + RssStore + SettingsStore + BtSettingsStore
        ├── viewmodel/DownloadViewModel.ts  # state owner + persistence + search/filter + queue schedule + MCP backend
        ├── mcp/                  # McpServer (local HTTP) + McpBackend
        ├── utils/common.ts       # formatting, URL parse, protocol detect; ColorSchemes; VersionChecker; StatsCalculator; SpeedLimiter; RssParser
        ├── util/                 # BackgroundTaskManager, NotificationHelper
        └── pages/Index.ets       # three-pane UI + detail (segments/BT panel) + settings (queues/categories)
```

---

## Decompilation-driven port

The port is driven by **decompiling the official Android APK** (FluxDown 0.4.7 / 0.4.8-rc.5) and
re-implementing the observable behavior natively:

- `decompiled/apktool/` — full `apktool` decode of `FluxDown-0.4.7-android-universal.apk`
  (AndroidManifest, smali, resources, Flutter assets including `i18n/*.json`).
- `docs/reference/反编译与移植分析报告.md` — gap analysis: A/B/C-class portability for every feature.
- `docs/reference/fluxdown-0.4.7-功能规格清单.md` — full feature spec extracted from the app's i18n strings.
- The i18n strings (`assets/flutter_assets/assets/i18n/zh.json`) are the source of truth for the
  Chinese feature labels used in the UI; a diff against 0.4.8-rc.5 (13 new keys: foreground-service
  notification, log status, direct-connect fallback) was folded into the analysis.

## UI 图标与布局移植

原应用的 UI 图标取自 **Lucide 图标集**（`lucide_icons_flutter` 包内的图标字体）。移植方式：

1. 从原 APK 的 `packages/lucide_icons_flutter/assets/lucide.ttf` 提取字形（171 个子集字形）；
   再用同版本 `lucide_icons_flutter` 源码的 codePoint→图标名映射 + `LucideVariable-w400.ttf`，
   用 fontTools 将 246 个核心图标字形轮廓转成 **填充版 SVG**（`fill="currentColor"`）。
2. 图标存于 `fluxdowncover/src/main/resources/base/media/ic_*.svg`（共 246 个），
   `pages/Index.ets` 顶部 `ICON` 查找表 + `iconRes(name)` 统一引用；
   ArkUI 的 `Image(...).fillColor(color)` 负责随主题/强调色着色（fillColor 仅作用于 fill，
   故 SVG 采用填充版而非描边版）。
3. **布局对齐**：任务行左侧协议图标（HTTP=globe、HTTPS=lock、BT=magnet、eD2K=hash、
   HLS/DASH=video、FTP/SFTP=server、Thunder=zap）+ 状态图标（排队=clock、下载中=loader、
   暂停=pause、校验=shield、完成=circle-check、错误=alert）；Tab 栏（全部/下载中/已完成）图标化；
   滑动操作与详情页操作按钮全部图标化；设置页每个设置项前置图标（cpu/shield-check/gauge/
   globe/code/clipboard/bell/trash/moon-sun/palette/terminal/lock 等）；统计页与队列/分类管理
   同样图标化；空状态大图标；关于页协议列表图标化。

---

## How to build & run (on your Mac, in DevEco Studio)

1. Copy / open the `FluxDownOHOS` folder as a project in **DevEco Studio 6.1+** (the device's
   API 24 / NEXT 6.1 toolchain).
2. The **HarmonyOS NEXT SDK (API 24)** is already installed (DevEco's bundled `default` SDK at
   `/Applications/DevEco-Studio.app/Contents/sdk/default/hms/`, `apiVersion 24 / version 6.1.1.125`).
   If DevEco still reports it missing, open **Settings → SDK Manager → HarmonyOS NEXT → API 24**.
3. **File → Sync and Refresh Project** (resolves `oh-package.json5`; hvigor is pinned to `6.24.4`
   to match the installed DevEco 6.1.1).
4. **Connect your Mate 60 Pro via USB** and ensure `hdc` sees it (`hdc list targets` → `FMR0224424008138`).
5. **Sign the app**: DevEco → **Project Structure → Signing Configs → Automatically generate**.
6. **Run** on the device (or use **Build → Build HAP**).

> Build is calibrated to the real device: `build-profile.json5` sets `compatibleSdkVersion`,
> `compileSdkVersion`, and `targetSdkVersion` all to **`24`** (integers — hvigor requires numbers
> for API 10–25; strings like `"6.1.1"` are rejected with "值不正确"), plus `arkTSVersion: "1.1"`,
> `runtimeOS: "HarmonyOS"`, hvigor `6.24.4`. The ArkTS APIs used
> (http / fs / picker / taskpool / relationalStore / socket / cryptoFramework / ArkUI V2) are all
> present and unchanged at API 24, so **no source changes were needed** for the API bump.

> ⚠️ Note: this project's build config was calibrated against the **real device via `hdc`**
> (HUAWEI Mate 60 Pro, **API 24 / HarmonyOS NEXT 6.1.1.120**). The code is written against the
> verified HarmonyOS NEXT (API 24) ArkTS APIs (see "API references" below) and should open and
> build in DevEco; please still treat the **FTP client and the MCP socket server as needing a
> real-device smoke test** — socket timing/behavior is device sensitive.

---

## On-device verification checklist

- [ ] Build succeeds; HAP installs on Mate 60 Pro.
- [ ] Tap **新建**, paste an `https://…/file.zip` URL → multi-segment progress advances; speed shows.
- [ ] **Pause** then **继续** → resumes from the same byte offset (file keeps growing, no restart).
- [ ] After completion, open the file in the app sandbox:
      `context.filesDir/downloads/` (use DevEco's Device File Browser).
- [ ] Kill & relaunch the app → in-progress tasks reappear as **已暂停** (persistence works).
- [ ] Settings → enable **MCP 本地服务**, then from a terminal on the phone/computer:
      `curl -X POST http://127.0.0.1:17800/mcp -H "Authorization: Bearer fluxdowncover-local"
       -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
- [ ] FTP: try an `ftp://…` URL (anonymous mirror) and confirm the file downloads.
- [ ] On a **completed** task, tap **导出** (list row) or **导出到公共 Download** (detail) →
      the file appears in the system **Download** directory, accessible from Files app.
- [ ] Settings → enable **下载完成后自动导出到公共 Download**, then finish a download →
      file lands in Download automatically (verify on-device; falls back to manual on gesture-restricted devices).

---

## Where files are saved (public Download directory)

Files are downloaded into the app sandbox (`context.filesDir/downloads/`) so they always exist,
survive app restart, and are private to FluxDown Cover. To make a finished file visible in the system
**Download** folder, use the **导出到公共 Download** action (available on completed tasks).

> **Why not `Environment.getUserDownloadDir()`?** Huawei's docs state that API returns error
> **801 ("Capability not supported") on phones** (it is only for 2-in-1 / Tablet devices). The
> Mate 60 Pro is a phone, so that path is unavailable. The device-correct alternative is the
> **`DocumentViewPicker`** in `DocumentPickerMode.DOWNLOAD`: it writes straight to the public
> Download directory with **no folder-picker UI and no extra permission** — the save gesture
> authorizes the returned URI. (Consequently `ohos.permission.READ_WRITE_DOWNLOAD_DIR` is **not**
> declared; it would be both unnecessary and inert on this device.)
>
> **Auto-export toggle:** Settings → *下载完成后自动导出到公共 Download*. When on, a finished
> file is pushed to Download automatically. This fires while the app is in the foreground; on
> devices that require an explicit user gesture for the picker it may be rejected — in that case
> the manual **导出** button is the reliable fallback (and failures are logged, never fatal).

---

## Key API references used (Huawei official docs)

- **HTTP streaming (no 5 MB cap):** `http.createHttp()` + `requestInStream()` + `'dataReceive'`
  events; `expectDataType: http.HttpDataType.ARRAY_BUFFER` for the probe. `@kit.NetworkKit`.
- **Positioned file writes:** `fs.write(fd, buffer, { offset })` — `offset` is the byte position.
  `@ohos.file.fs` / `@kit.CoreFileKit`.
- **Public Download export:** `picker.DocumentViewPicker.save({ pickerMode: DocumentPickerMode.DOWNLOAD })`
  → returns the Download URI; `new fileUri.FileUri(uri + '/' + name).path` → `fs.openSync` /
  `fs.copyFileSync`. `@kit.CoreFileKit`.
- **Sockets:** `socket.constructTCPSocketInstance()`, `connect`, `bind` + `'connect'` (server),
  `'message'` (payload `.message: ArrayBuffer`). `@kit.NetworkKit`.
- **Multithreading:** `@Concurrent` + `taskpool.execute(new taskpool.Task(...))`. `@kit.ArkTS`.
- **Persistence:** `relationalStore.getRdbStore` / `insert` / `update` / `query` / `RdbPredicates`.
  `@kit.ArkData`.
- **State:** `@ObservedV2` / `@Trace` (deep observation, drives ArkUI); `@ComponentV2` pages.

---

## Mapping to the original repo

| Original (FluxDown) | FluxDown Cover (this port) |
|---|---|
| `native/engine` (Rust) | `engine/DownloadEngine.ts` + `protocols/*` |
| `native/hub` (Rinf FFI) | removed — native ArkTS instead of Flutter↔Rust bridge |
| `lib/` (Flutter UI) | `pages/Index.ets` + `viewmodel/` |
| `native/api/src/mcp.rs` | `mcp/McpServer.ts` (HTTP JSON-RPC on :17800) |
| `fluxDown/` (browser ext) | out of scope; OHOS side would expose the same MCP tools |
| SQLite state | `store/` (relationalStore) |

---

## License

FluxDown Cover is distributed under **AGPL-3.0**. This port follows the same license; keep it open
source if you redistribute.
