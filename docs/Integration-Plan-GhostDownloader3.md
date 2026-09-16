# FluxDown Cover × Ghost-Downloader-3 技术整合方案

> **版本**：v1.0  
> **日期**：2026-09-16  
> **作者**：DuMate  
> **状态**：待审阅

---

## 一、项目概述

### 1.1 背景

用户希望将开源下载器 **[Ghost-Downloader-3](https://github.com/XiaoYouChR/Ghost-Downloader-3)** 的核心逻辑整合到鸿蒙应用 **FluxDown Cover** 中。Ghost-Downloader-3 是一款基于 Python + PySide6 的跨平台多协议下载工具，具备智能分块、自动加速、插件化架构等先进特性。

### 1.2 技术差异

| 维度 | Ghost-Downloader-3 | FluxDown Cover |
|------|-------------------|----------------|
| **语言** | Python 3.13 | ArkTS / TypeScript |
| **UI 框架** | PySide6 (Qt) | ArkUI / HarmonyOS |
| **运行时** | CPython + asyncio | HarmonyOS SDK + V8 |
| **HTTP 客户端** | wreq (自定义) | `@kit.NetworkKit` |
| **BT 引擎** | libtorrent (C++) | 自研 BtEngine (TS) |
| **持久化** | JSONL + 二进制 .ghd | SQLite |
| **平台** | Win/macOS/Linux | HarmonyOS |

> **结论**：无法直接移植代码，需**借鉴架构设计**，在 ArkTS 中重新实现核心算法。

---

## 二、Ghost-Downloader-3 架构分析

### 2.1 目录结构（183 个 Python 文件）

```
Ghost-Downloader-3/
├── app/                          # 核心应用层
│   ├── services/                 # 业务服务
│   │   ├── task_service.py       # 任务调度与队列管理 ⭐
│   │   ├── coroutine_runner.py   # 协程调度器
│   │   ├── speed_meter.py        # 速度计量器 ⭐
│   │   ├── aria2_rpc.py          # aria2 RPC 兼容
│   │   └── ...
│   ├── models/                   # 数据模型
│   │   ├── task.py               # Task/TaskStep 状态机 ⭐
│   │   ├── pack.py               # 插件模型
│   │   └── serialization.py      # 序列化
│   ├── client.py                 # HTTP 客户端构建器
│   ├── config/                   # 配置管理
│   └── view/                     # Qt UI（不可移植）
├── features/                     # 插件化协议包
│   ├── http_pack/                # HTTP 多线程下载 ⭐
│   │   ├── pack.py               # URL 解析与任务创建
│   │   └── task.py               # 分块下载逻辑 ⭐
│   ├── bittorrent_pack/          # BT/磁力链
│   ├── bili_pack/                # Bilibili 视频解析
│   ├── yt_dlp_pack/              # YouTube 解析
│   ├── m3u8_pack/                # HLS 流媒体
│   ├── ffmpeg_pack/              # 视频合并
│   ├── github_pack/              # GitHub 加速
│   ├── huggingface_pack/         # HuggingFace 加速
│   └── ed2k_pack/                # eD2k 协议
├── browser_extension/            # 浏览器扩展
└── compose/                      # Android Compose UI
```

### 2.2 核心依赖

```toml
[project]
dependencies = [
    "wreq>=0.12.0",              # 自定义 HTTP 客户端
    "libtorrent>=2.0.13",        # BitTorrent C++ 库
    "pyside6~=6.10.3",           # Qt UI（不可移植）
    "m3u8>=6.0.0",               # HLS 解析
    "mpegdash>=0.4.1",           # DASH 解析
    "aioftp[socks]>=0.27.2",     # FTP 客户端
    "desktop-notifier>=6.2.0",   # 桌面通知
]
```

### 2.3 关键算法

#### A. 智能分块算法（http_pack/task.py）

```python
# 1. 初始均分
def _buildSubworkers(self) -> list[HttpSubworker]:
    count = min(self.subworkerCount, self.fileSize)
    chunkSize = self.fileSize // count
    # 均分文件为 count 个 byte range

# 2. 动态拆分慢速分块
def _splitSlowest(self) -> HttpSubworker | None:
    slowest = max(self.subworkers, key=lambda sw: sw.end - sw.position + 1)
    remainingBytes = slowest.end - slowest.position + 1
    # 将最慢分块拆分为两个，新分块分配给新连接

# 3. 自动重新分配
def _reassignSubworker(self) -> None:
    # 当某分块剩余字节 > 阈值时，自动拆分并创建新下载任务
```

#### B. 自动加速算法

```python
def _autoSpeedUp(self) -> None:
    # 收集最近 5 秒速度历史
    # 计算平均速度和最大偏差
    # 若速度稳定（偏差 < 15%），自动增加分块数
```

#### C. 任务调度队列（task_service.py）

```python
class TaskQueue:
    _waiting: list[str]        # 等待队列（按优先级排序）
    _running: dict[str, str]   # 运行中任务 → workId 映射
    
    def nextWaiting(self) -> str | None:
        return self._waiting.pop(0) if self._waiting else None
```

---

## 三、FluxDown Cover 现有架构

### 3.1 目录结构

```
fluxdowncover/src/main/ets/
├── engine/
│   ├── DownloadEngine.ts       # 核心下载引擎 ⭐
│   ├── EngineHooks.ts          # 引擎钩子接口
│   ├── HashTask.ts             # 哈希校验（TaskPool）
│   ├── BtEngine.ts             # BitTorrent 引擎
│   └── protocols/              # 协议实现
│       ├── BittorrentProtocol.ts
│       ├── HlsProtocol.ts
│       ├── DashProtocol.ts
│       ├── FtpProtocol.ts
│       ├── Ed2kProtocol.ts
│       └── SftpProtocol.ts
├── model/
│   ├── DownloadTask.ts         # 下载任务模型 ⭐
│   ├── TaskStatus.ts           # 任务状态枚举
│   ├── ProtocolType.ts         # 协议类型枚举
│   ├── DownloadQueue.ts        # 下载队列
│   └── DownloadCategory.ts     # 任务分类
├── store/
│   └── TaskRepository.ts       # SQLite 持久化
├── utils/
│   ├── SpeedLimiter.ts         # 速度限制器 ⭐
│   ├── common.ts               # 通用工具
│   └── ...
├── viewmodel/
│   └── DownloadViewModel.ts    # UI 数据绑定
└── pages/
    ├── Index.ets               # 主页面
    └── SplashPage.ets          # 开屏页
```

### 3.2 现有能力清单

| 能力 | 状态 | 备注 |
|------|------|------|
| 多段 HTTP 下载 | ✅ | 固定分块数，动态分段 |
| HLS (m3u8) | ✅ | AES-128 解密支持 |
| DASH (MPD) | ✅ | SegmentTemplate 支持 |
| FTP | ✅ | Passive 模式 |
| BitTorrent | ✅ | DHT + PeerWire + UPnP |
| eD2k | ✅ | 自研协议栈 |
| SQLite 持久化 | ✅ | TaskRepository |
| 速度限制 | ✅ | 全局 + 单任务 |
| 后台下载 | ✅ | BackgroundTaskManager |
| 实况窗 | ✅ | LiveViewHelper |
| SHA-256 校验 | ✅ | TaskPool 离线程 |

### 3.3 当前不足

1. **分块策略固定**：`maxSegments` 为固定值（默认 8），不会根据网络状况动态调整
2. **缺少智能加速**：无法自动检测带宽利用率并增加分块
3. **任务调度简单**：缺少优先级队列和并发控制
4. **无站点解析器**：缺少 Bilibili、GitHub、HuggingFace 等特定站点的 URL 预处理和镜像加速
5. **无 aria2 兼容**：不支持 aria2 RPC 协议

---

## 四、整合策略

### 4.1 模块映射表

| Ghost-Downloader-3 模块 | FluxDown Cover 目标位置 | 移植策略 | 优先级 |
|------------------------|------------------------|---------|--------|
| `http_pack/task.py` 智能分块 | `engine/DownloadEngine.ts` | **重新实现**动态分块算法 | P0 |
| `http_pack/task.py` 自动加速 | `engine/DownloadEngine.ts` | **重新实现**加速检测逻辑 | P0 |
| `task_service.py` TaskQueue | `model/DownloadQueue.ts` | **增强**现有队列，增加优先级 | P1 |
| `speed_meter.py` | `utils/SpeedLimiter.ts` | **增强**现有速度计算 | P1 |
| `bili_pack/` | `engine/protocols/BiliProtocol.ts` | **新增**B站视频解析 | P2 |
| `github_pack/` | `engine/protocols/GithubProtocol.ts` | **新增**GitHub 加速 | P2 |
| `aria2_rpc.py` | `engine/Aria2Rpc.ts` | **新增**aria2 兼容 | P2 |
| `features/yt_dlp_pack/` | 服务器端代理 | **不可移植**，需后端支持 | P3 |
| `libtorrent` | `engine/BtEngine.ts` | 已有自研实现，**保持现状** | - |
| `PySide6 UI` | `pages/` | 已有 ArkUI，**保持现状** | - |

### 4.2 详细移植方案

#### P0｜智能动态分块（最重要）

**Ghost 设计：**
- 初始均分为 N 个 byte range
- 每 1 秒检查各分块进度
- 找出剩余字节最多的"慢速分块"
- 若慢速分块剩余 > 阈值，拆分为两个，新连接下载后半部分
- 最多支持 32 个并发分块

**FluxDown 实现：**

```typescript
// engine/DownloadEngine.ts 新增

interface Segment {
  index: number;
  start: number;
  end: number;
  downloaded: number;
  done: boolean;
  // 新增：连接速度追踪
  speedHistory: number[];  // 最近 5 秒速度 (bytes/s)
}

class DownloadEngine {
  // 新增动态分块控制
  private autoReassign: boolean = true;
  private reassessIntervalMs: number = 2000;
  private minReassignSize: number = 256 * 1024; // 256KB
  private maxConnections: number = 32;
  
  /**
   * 动态分块重分配
   * 每 2 秒评估一次各分块速度，拆分慢速分块
   */
  private async reassessSegments(task: DownloadTask): Promise<void> {
    if (!this.autoReassign || task.segments.length >= this.maxConnections) {
      return;
    }
    
    // 找出剩余字节最多的分块
    const slowest = task.segments
      .filter(s => !s.done)
      .sort((a, b) => (b.end - b.start - b.downloaded) - (a.end - a.start - a.downloaded))[0];
    
    if (!slowest) return;
    
    const remaining = slowest.end - slowest.start - slowest.downloaded;
    if (remaining < this.minReassignSize) return;
    
    // 拆分：前半部分继续由原连接下载，后半部分创建新连接
    const splitPoint = slowest.start + slowest.downloaded + Math.floor(remaining / 2);
    const newSegment: Segment = {
      index: task.segments.length,
      start: splitPoint,
      end: slowest.end,
      downloaded: 0,
      done: false,
      speedHistory: []
    };
    
    slowest.end = splitPoint - 1;
    task.segments.push(newSegment);
    
    // 启动新连接下载新分块
    this.downloadSegment(task, newSegment);
  }
}
```

#### P0｜自动加速

**Ghost 设计：**
- 收集最近 5 秒速度历史
- 计算平均速度和最大偏差
- 若偏差 < 15%（速度稳定），增加分块数

**FluxDown 实现：**

```typescript
// 在 DownloadEngine 的 ticker 中集成

private speedHistory: Map<string, number[]> = new Map();
private autoSpeedUpEnabled: boolean = true;

private checkAutoSpeedUp(task: DownloadTask): void {
  if (!this.autoSpeedUpEnabled) return;
  
  const history = this.speedHistory.get(task.id) || [];
  history.push(task.speed);
  if (history.length > 5) history.shift();
  this.speedHistory.set(task.id, history);
  
  if (history.length < 5) return;
  
  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  if (avg === 0) return;
  
  const maxDeviation = Math.max(...history.map(s => Math.abs(s - avg) / avg));
  if (maxDeviation < 0.15) {
    // 速度稳定，尝试增加分块
    this.reassessSegments(task);
  }
}
```

#### P1｜任务队列增强

**Ghost 设计：**
- 等待队列 + 运行队列
- 支持优先级排序
- 最大并发数控制
- 任务完成/失败后自动从队列取出下一个

**FluxDown 实现：**

```typescript
// model/DownloadQueue.ts 增强

interface QueuedTask {
  taskId: string;
  priority: number;      // 数值越大优先级越高
  addedAt: number;
  status: 'waiting' | 'running' | 'paused';
}

class DownloadQueue {
  private waiting: QueuedTask[] = [];
  private running: Set<string> = new Set();
  private maxConcurrent: number = 3;
  
  enqueue(task: DownloadTask, priority: number = 0): void {
    this.waiting.push({
      taskId: task.id,
      priority,
      addedAt: Date.now(),
      status: 'waiting'
    });
    this.waiting.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
    this.pump();
  }
  
  private pump(): void {
    while (this.running.size < this.maxConcurrent && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.running.add(next.taskId);
      // 启动下载
    }
  }
}
```

#### P1｜速度计量增强

**Ghost 设计：**
- 1 秒 tick，累计字节数清零
- 支持全局 + 单任务限速

**FluxDown 现状：**
- 已有 SpeedLimiter，但速度计算可能不够精确

**改进：**
- 在 Engine 中增加精确的字节计数器
- 支持滑动窗口平均速度（最近 3 秒）

#### P2｜站点解析器（Bilibili / GitHub / HuggingFace）

**Ghost 设计：**
- 每个站点一个 Feature Pack
- Pack 包含：URL 解析、任务创建、配置卡片、设置项

**FluxDown 实现：**

```typescript
// engine/protocols/SiteParser.ts

interface SiteParser {
  readonly hostPattern: RegExp;
  parse(url: string): Promise<ParsedTask>;
}

class BiliParser implements SiteParser {
  hostPattern = /^(www\.)?bilibili\.com$/;
  
  async parse(url: string): Promise<ParsedTask> {
    // 解析 BV 号/avid，获取视频信息
    // 返回多清晰度可选的下载任务
  }
}

class GithubParser implements SiteParser {
  hostPattern = /^(github\.com|raw\.githubusercontent\.com)$/;
  
  async parse(url: string): Promise<ParsedTask> {
    // 检测是否为 release/asset/raw
    // 应用镜像加速（ghproxy 等）
  }
}
```

#### P2｜aria2 RPC 兼容

**Ghost 设计：**
- 提供 aria2-compatible RPC 接口
- 第三方工具可通过 RPC 添加/管理任务

**FluxDown 实现：**
- 新增 `engine/Aria2Rpc.ts`
- 实现 aria2.addUri、aria2.tellStatus 等核心方法
- 通过 MCP 或本地 HTTP 服务暴露 RPC 接口

---

## 五、接口设计

### 5.1 新增 Engine API

```typescript
interface DownloadEngine {
  // 动态分块控制
  setAutoReassign(enabled: boolean): void;
  setMaxConnections(n: number): void;
  setMinReassignSize(bytes: number): void;
  
  // 自动加速
  setAutoSpeedUp(enabled: boolean): void;
  
  // 队列管理
  setMaxConcurrentTasks(n: number): void;
  setTaskPriority(taskId: string, priority: number): void;
  
  // 站点解析器注册
  registerSiteParser(parser: SiteParser): void;
  
  // aria2 RPC
  startAria2Rpc(port: number): void;
  stopAria2Rpc(): void;
}
```

### 5.2 新增配置项

```typescript
interface EngineConfig {
  // 分块
  autoReassign: boolean;        // 动态分块（默认 true）
  maxConnections: number;       // 最大连接数（默认 16）
  minReassignSize: number;      // 最小拆分大小（默认 256KB）
  
  // 加速
  autoSpeedUp: boolean;         // 自动加速（默认 true）
  speedStabilityThreshold: number; // 速度稳定性阈值（默认 0.15）
  
  // 队列
  maxConcurrentTasks: number;   // 最大并发任务数（默认 3）
  
  // 站点
  githubMirror: string;         // GitHub 镜像前缀
  biliQuality: 'highest' | 'high' | 'medium' | 'low';
}
```

---

## 六、风险评估

| 风险 | 级别 | 描述 | 缓解措施 |
|------|------|------|---------|
| **动态分块导致文件碎片** | 中 | 多个连接写入同一文件不同位置，可能产生碎片 | 使用预分配文件 + 定点写入 |
| **连接数过多被服务器拒绝** | 中 | 动态分块可能导致 32+ 连接 | 设置服务器级别的连接上限检测 |
| **自动加速误判** | 低 | 速度稳定但已达带宽上限，继续增加分块无意义 | 设置最大连接数上限 + 速度增益检测 |
| **站点解析器维护成本** | 中 | B站/YouTube 等站点经常改版 | 模块化设计，便于独立更新 |
| **aria2 RPC 安全** | 低 | 暴露本地 RPC 接口有安全风险 | 默认关闭，仅本地监听 |
| **内存占用增加** | 低 | 更多并发分块意味着更多缓冲区 | 限制单任务最大内存 |

---

## 七、实施计划

### Phase 1：核心增强（P0，预计 3-4 天）

1. **Day 1**：实现智能动态分块算法
   - 修改 `DownloadEngine.ts`，增加 Segment 拆分/重分配逻辑
   - 修改 HTTP 下载循环，支持动态增减分块
   
2. **Day 2**：实现自动加速
   - 增加速度历史收集
   - 实现稳定性检测和自动分块增加
   
3. **Day 3-4**：测试与调优
   - 不同网络环境下的分块策略验证
   - 大文件/小文件场景测试

### Phase 2：队列与速度（P1，预计 2-3 天）

1. **Day 1**：增强 DownloadQueue
   - 优先级队列
   - 并发控制
   
2. **Day 2**：速度计量增强
   - 滑动窗口平均
   - 精确限速
   
3. **Day 3**：集成测试

### Phase 3：站点解析器（P2，预计 4-5 天）

1. **Day 1-2**：Bilibili 解析器
2. **Day 3**：GitHub 解析器
3. **Day 4**：HuggingFace 解析器
4. **Day 5**：集成测试

### Phase 4：aria2 RPC（P2，预计 2-3 天）

1. **Day 1-2**：实现核心 RPC 方法
2. **Day 3**：集成与测试

---

## 八、预期收益

| 指标 | 当前 | 目标 | 提升 |
|------|------|------|------|
| 单任务下载速度 | 受限于固定分块 | 动态分块充分利用带宽 | +20-50% |
| 大文件 (>1GB) 下载效率 | 一般 | 智能分块显著提升 | +30-80% |
| 任务并发管理 | 无明确队列 | 优先级队列 + 并发控制 | 更可控 |
| 站点支持 | 通用 HTTP | B站/GitHub/HuggingFace 加速 | 更广泛 |
| 第三方兼容 | 无 | aria2 RPC | 生态扩展 |

---

## 九、附录

### A. Ghost-Downloader-3 关键源码引用

- `features/http_pack/task.py:128-171` — 分块构建与动态拆分
- `features/http_pack/task.py:183-210` — 自动加速
- `app/services/task_service.py:85-133` — 任务队列
- `app/services/speed_meter.py:1-53` — 速度计量

### B. FluxDown Cover 现有源码引用

- `engine/DownloadEngine.ts:36-200` — 引擎核心
- `model/DownloadTask.ts:33-91` — 任务模型
- `utils/SpeedLimiter.ts` — 速度限制

---

> **下一步**：请审阅本方案，确认后进入 Phase 1 实施。
