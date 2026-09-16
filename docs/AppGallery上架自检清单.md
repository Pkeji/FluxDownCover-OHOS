# FluxDown Cover — 华为应用市场上架自检清单

> 生成时间：2026-09-14　应用：FluxDown Cover　包名：`com.fluxdowncover.fluxdowncoverohos`

---

## 一、本次已修复 / 已准备

| # | 项目 | 说明 |
|---|------|------|
| 1 | 图标光学尺寸统一 | `ic_update` 20→22、`ic_github` 24→22、`ic_qq` 24.2→22，与项目主体 Lucide 体系（长边 22）一致 |
| 2 | 开源许可披露 | 按「组件名称 / 版本 / 使用方式 / 版权所有 / 许可证 / 源码地址」重写 `NOTICE` 与应用内「开源致谢」 |
| 3 | OpenAuthenticator 许可更正 | MIT → **GPL-3.0**，并说明「仅设计参考、未使用源代码，不构成衍生作品」 |
| 4 | 关于页 QQ 群弹窗 | 两个 `bindSheet` 绑同一宿主导致抢占，已合并为单 sheet + `activeSheet` 分发 |
| 5 | 关于页顺序 | 检查更新 → 访问仓库 → 开源致谢 → QQ 交流群 → 隐私政策 |
| 6 | 隐私政策 | APP 内 `PrivacyPolicy.ts` 与 AGC 用 `privacy_policy.html` 同步补「通知与实况窗」说明 |

---

## 二、自检结果（已核对，全部通过）

| 检查项 | 结果 | 依据 |
|--------|------|------|
| 应用名一致性 | ✅ | `app_name = FluxDown Cover`，关于页标题一致 |
| 版本号一致性 | ✅ | `versionName 1.2.4.200` / `versionCode 102040200` / `APP_VERSION` 常量三者一致 |
| 应用图标 | ✅ | `layered_image.json` + `app_icon/background/foreground/startIcon` 齐全 |
| 首启隐私弹窗 | ✅ | `showPrivacyDialog` 首启弹出，同意前不初始化 |
| 权限最小化 | ✅ | 仅 4 项：INTERNET / GET_NETWORK_INFO / KEEP_BACKGROUND_RUNNING / GET_BUNDLE_INFO |
| 权限理由文案 | ✅ | `string.json` 中 4 项 reason 齐全且与隐私政策对应 |
| 隐私政策覆盖权限 | ✅ | 两版均覆盖全部 4 项权限 + 剪贴板 + 通知实况窗 + 文件存储 |
| 第三方 SDK | ✅ | 无 HMS Core / AGC / 支付 / 推送 / 统计；仅系统 Kit + `@tangs/components`(Apache-2.0) |
| 功能完整性 | ✅ | 11 个协议中 10 个已实现，仅 SFTP 标「开发中」，且对外介绍未提及 SFTP |
| 介绍与实际相符 | ✅ | 关于页宣传的 6 类协议全部为已实现状态 |
| 开源义务 | ✅ | AGPL-3.0，完整源码公开：`https://github.com/Pkeji/FluxDownCover-OHOS` |
| 调试残留 | ✅ | 源码无 `console.log/debug/info` |
| 路由配置 | ✅ | `main_pages.json` = SplashPage + Index |

---

## 三、必须由你完成的操作（我无法代为登录 / 上传）

> 🚧 **当前阻塞（2026-09-14）**：自动化浏览器登录触发华为风控——页面提示「因您尚未信任此浏览器，请进行身份验证」（滑块/可信设备验证）。
> 此前多次自动生成二维码 / 请求短信已引发风控。该步需你本人完成：
> - 方案 A（推荐）：用你**已登录华为账号的 Mac Safari** 打开 AGC 控制台，直接创建应用并上传（见步骤 4），我这边已备好包与文案；
> - 方案 B：在我驱动的浏览器里完成该「验证」交互（若为滑块我尝试拖拽；若为可信设备码，你提供后我继续）。
> 无论哪种，上传都还需要 **3 张以上真机截图**（步骤 4 列出），此项我也无法代生成。

以下涉及华为开发者账号登录、DevEco GUI 构建与监管备案，**无法由我代执行**：

### 步骤 1 — 切换发布签名（DevEco Studio）✅ 已完成
`build-profile.json5` 中 `products.default.signingConfig` 已切到 **`release`**（2026-09-14 03:10 修改）。
已验证 `build/outputs/default/fluxdowncoverohos.app` 使用 release 证书签名（AppGallery 发布 profile，叶龙发 Release），bundle `com.fluxdowncover.fluxdowncoverohos`、version 1.2.4.200（code 102040200）、buildMode=release/debug=false、设备 phone/tablet/2in1。

> ⚠️ 遗留问题（不影响本次）：`signingConfigs.default` 引用的 `/Users/Zhuanz/Downloads/FluxDown Cover.cer` **文件不存在**，但 product 已不使用 default 配置，无影响；
> `default` 与 `release` 对同一个 `fluxdowncover.p12` 使用不同 storePassword（DevEco 加密值），仅在误切回 default 时才报错。

### 步骤 2 — 构建发布包 ✅ 已完成
`build/outputs/default/fluxdowncoverohos.app`（03:32，约 1.3MB，release 签名）已生成。
已用 `find src -newer` 校验：无任何源码文件晚于 03:32，即包内含全部最新修改（图标归一、关于页、NOTICE、隐私政策）。
如需绝对保险，上传前可再 `Build → Clean Project + Rebuild Project` 后 `Generate APP`。

### 步骤 2.5 — AGC 云测 UX 问题修复并重打包（2026-09-14 17:28）✅ 已完成
针对首次云测（报告 1306102871157275646，Mate 80 / Mate X5）两条问题完成修复并重新出 release 1.2.4.200 正式包：
- **色彩对比度不通过（5 次）**：新增 WCAG 对比度工具，浅色模式下默认主色与成功/警告/错误语义色仅在不足时自动降明度至正文 ≥4.5:1、图标 ≥3:1（深色模式不动、18 套主题色相不变）；同步修复写死浅灰文字（#888888/#8E8E93/#8A8F98）与「彩底白字」操作按钮（绿/橙/蓝/红加深为白字 ≥4.5:1）、删除弹窗按钮改主题色。
- **布局合理美观警告（Mate X5）**：下载主页状态筛选一排（全部/下载中/…/错误）字号不再随折叠↔展开跳变，展开/折叠字号比 ≤1.09（规则上限 1.2），仅 PC(2in1) 用 13fp。
- **设备适配原则调整**：框架级大屏判断由「窗口宽度 >600」改为 `deviceInfo.deviceType==='2in1'`——手机（含折叠屏 Mate X5）与平板同为触控、共用移动布局；仅 PC/2in1 走宽悬浮导航/关闭系统材质/更大标题栏。保留弹窗限宽(<600)与任务网格多列(>700/>1000)的宽度响应。
- 已用真机（phone, ALN-AL00）浅色/深色与 2in1 模拟器浅色实测验证；`clean assembleApp` 全新构建，release 签名，releaseType=Release，产物已覆盖 `上架材料/FluxDownCover_1.2.4.200_release.app/.hap`（md5 与构建产物一致）。
- 后续：需在 AGC 重新发起云测，确认两条问题清零。

### 步骤 3 — APP 备案 ⏳ 待你操作（监管外部动作）
鸿蒙版需在接入商备案系统选择「鸿蒙」平台并填写鸿蒙包名，备案主体/名称需与在架信息一致。

### 步骤 4 — AGC 创建应用并上传 ✅ 素材已生成
登录 AppGallery Connect → 我的应用 → 新建应用（HarmonyOS）→ 上传 APP 包 → 填写：
- 应用分类：**工具 > 文件管理/下载**
- 隐私政策链接（需先把 `privacy_policy.html` 托管到可访问 URL，如 GitHub Pages）
- 隐私标签：如实填写（本应用不收集个人信息，可勾选"不收集"）
- 测试账号：本应用无需登录，填"无"
- 应用图标与截图（已按设备类型整理）：
  - **手机**：沿用你已上传的 5 张截图
  - **平板**：`上架材料/截图_平板/` 下 5 张 **1280×1920（2:3 竖屏）** JPG
  - **PC/2in1**：`上架材料/截图_PC/` 下 **4 张 1920×1080（16:9 横屏）** JPG，均从 MateBook Pro 2in1 模拟器真实截取并中心裁切
  - **应用图标（三端可复用）**：`上架材料/应用图标_1024.png`（1024×1024，由项目分层图标合成）
  - **市场推广图（可选）**：`上架材料/02_全协议识别_美化_1920x1080.jpg`，按手机「市场版」风格美化，用于介绍页或推荐位

### 步骤 5 — 提审备注建议写
> 本应用为 AGPL-3.0 开源项目的 HarmonyOS 移植版，完整对应源代码公开可获取：
> https://github.com/Pkeji/FluxDownCover-OHOS
> 第三方开源组件清单见应用内「设置 → 关于 → 开源致谢」及仓库 NOTICE 文件。
> 本应用未集成任何华为可选商业 SDK，未集成第三方统计/广告/推送 SDK。

---

## 四、风险提示

| 风险 | 等级 | 说明 |
|------|------|------|
| 后台运行权限 | 中 | `KEEP_BACKGROUND_RUNNING` 属敏感权限，审核常要求说明必要性。已有 reason 文案与隐私政策说明，建议在提审备注中再次强调"仅用于用户主动发起的下载任务" |
| AGPL/GPL 类许可 | 低 | 华为开发者服务协议 4.1(b)(ii) 规定"将华为 SDK 与产品结合时不得使用 GPL 类软件"。本项目**未集成任何华为可选 SDK**，仅使用系统 Kit，风险已规避 |
| 查询已安装应用 | 低 | `GET_BUNDLE_INFO` 仅用于点击 QQ 群时检测 QQ 是否安装，已在隐私政策明确说明"仅本地判断、不上传" |
| 签名配置 | 低 | 已切 `release` 并已验证 `fluxdowncoverohos.app` 可正常签名；`default` 配置缺陷未使用 |

---

## 五、可直接使用的上架文案

**一句话简介**
> 多协议下载管理器，支持 BT、eD2K、磁力与流媒体下载

**应用介绍**
> FluxDown Cover 是一款面向 HarmonyOS 的多协议下载管理工具。
>
> 支持 HTTP/HTTPS、FTP、HLS/DASH 流媒体、BitTorrent、eD2K 网络，以及迅雷、快车、旋风专用链接解析。
>
> 主要功能：
> - 多线程分段下载，支持断点续传与速度限制
> - BitTorrent 下载与做种，支持 DHT、Tracker、UPnP 端口映射
> - HLS/DASH 流媒体探测与合并下载
> - 任务分类、下载队列与优先级管理
> - RSS 订阅自动下载
> - 本地 MCP 服务，支持与本地 AI 工具联动
> - 系统通知与实况窗实时展示下载进度
>
> 本应用完全本地运行，不注册账号、不收集个人信息，并以 AGPL-3.0 开源。

**新版本特性**
> - 新增 BitTorrent 做种与 DHT/UPnP 支持
> - 关于页新增开源致谢清单，完善第三方开源许可披露
> - 修复部分场景下的弹窗与跳转问题
> - 统一界面图标视觉尺寸，优化关于页信息层级
