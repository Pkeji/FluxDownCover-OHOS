# FluxDown for HarmonyOS (ArkTS)

This is a **port of [FluxDown](https://github.com/zerx-lab/FluxDown)** — the Rust + Flutter
multi-protocol download manager — to **HarmonyOS NEXT**, written in **ArkTS / ArkUI**
(the native HarmonyOS language), as a Stage-model DevEco Studio project.

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
| HLS (`.m3u8`) download | ✅ Full | Playlist parse + sequential `.ts` append; master→variant follow |
| FTP download (passive) | ✅ Implemented | Anonymous PASV `RETR`; **validate on-device** (socket timing) |
| SHA-256 integrity check | ✅ Full | Runs off the UI thread in **TaskPool** (`@Concurrent` + `cryptoFramework`) |
| SQLite persistence | ✅ Full | `@ohos.data.relationalStore` (ArkData) |
| Three-pane ArkUI | ✅ Full | Master/detail `Navigation` + settings; light/dark themes |
| MCP server (AI-agent) | ✅ Implemented | Local HTTP JSON-RPC on `127.0.0.1:17800`, Bearer-auth, 5 tools |
| Save to public **Download** dir | ✅ Full | `DocumentViewPicker` DOWNLOAD mode — manual "导出" button + optional auto-export toggle |
| BitTorrent | ✅ Implemented | HTTP tracker, peer wire protocol, SHA-1 piece verification |
| eD2K (eDonkey) | ✅ Implemented | Server + peer wire protocol, MD4 chunk verification |
| Thunder / FlashGet / QQDL | ✅ Implemented | Wrapper-protocol decoders — base64 decode → re-dispatch to real protocol |
| SFTP | ⛔ Not supported | Requires SSH transport layer; URL parser ready, clear error message |
| Browser extension | ⛔ Out of scope | Original is a separate WXT/TS extension; OHOS side hooks documented below |

---

## Project structure

```
FluxDownOHOS/
├── build-profile.json5            # product: API 12, runtimeOS HarmonyOS
├── oh-package.json5
├── AppScope/                      # app-level bundle name, icon, label
└── entry/src/main/
    ├── module.json5              # abilities + permissions (INTERNET, GET_NETWORK_INFO)
    ├── resources/                # strings, colors, icons, pages profile
    └── ets/
        ├── entryability/EntryAbility.ts     # boot: init DB + engine
        ├── model/                # DownloadTask (@ObservedV2), TaskStatus, ProtocolType
        ├── engine/
        │   ├── DownloadEngine.ts # orchestrator: probe→segment→resume→verify
        │   ├── HashTask.ets      # @Concurrent SHA-256 (TaskPool)
        │   ├── EngineHooks.ts / types.ts
        │   └── protocols/
        │       ├── HlsProtocol.ts       # parse + append .ts
        │       ├── FtpProtocol.ts       # passive-mode client (@ohos.net.socket)
        │       ├── BittorrentProtocol.ts # tracker + peer wire + SHA-1
        │       ├── Ed2kProtocol.ts       # eDonkey server + peer protocol
        │       ├── ThunderProtocol.ts    # thunder/flashget/qqdl decoder
        │       └── SftpProtocol.ts       # URL parser (SSH not supported)
        ├── store/                # DatabaseManager (RDB) + TaskRepository
        ├── viewmodel/DownloadViewModel.ts  # state owner + persistence + MCP backend
        ├── mcp/                  # McpServer (local HTTP) + McpBackend
        ├── utils/common.ts       # formatting, URL parse, protocol detect
        └── pages/Index.ets       # three-pane UI
```

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
      `curl -X POST http://127.0.0.1:17800/mcp -H "Authorization: Bearer fluxdown-local"
       -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
- [ ] FTP: try an `ftp://…` URL (anonymous mirror) and confirm the file downloads.
- [ ] On a **completed** task, tap **导出** (list row) or **导出到公共 Download** (detail) →
      the file appears in the system **Download** directory, accessible from Files app.
- [ ] Settings → enable **下载完成后自动导出到公共 Download**, then finish a download →
      file lands in Download automatically (verify on-device; falls back to manual on gesture-restricted devices).

---

## Where files are saved (public Download directory)

Files are downloaded into the app sandbox (`context.filesDir/downloads/`) so they always exist,
survive app restart, and are private to FluxDown. To make a finished file visible in the system
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

| Original (FluxDown) | This port |
|---|---|
| `native/engine` (Rust) | `engine/DownloadEngine.ts` + `protocols/*` |
| `native/hub` (Rinf FFI) | removed — native ArkTS instead of Flutter↔Rust bridge |
| `lib/` (Flutter UI) | `pages/Index.ets` + `viewmodel/` |
| `native/api/src/mcp.rs` | `mcp/McpServer.ts` (HTTP JSON-RPC on :17800) |
| `fluxDown/` (browser ext) | out of scope; OHOS side would expose the same MCP tools |
| SQLite state | `store/` (relationalStore) |

---

## License

FluxDown is distributed under **AGPL-3.0**. This port follows the same license; keep it open
source if you redistribute.
