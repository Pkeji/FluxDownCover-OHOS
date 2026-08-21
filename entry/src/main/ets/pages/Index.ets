import { promptAction } from '@kit.ArkUI';
import { common, Want } from '@kit.AbilityKit';
import { DownloadViewModel } from '../viewmodel/DownloadViewModel';
import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';
import { formatBytes, formatSpeed, detectProtocol, protocolMeta, ALL_PROTOCOLS, fileNameFromUrl } from '../utils/common';
import { COLOR_SCHEMES, getScheme, ColorScheme } from '../utils/ColorSchemes';
import { DownloadQueue } from '../model/DownloadQueue';
import { RssSubscription } from '../model/RssSubscription';

interface Palette {
  bg: string;
  surface: string;
  surfaceSolid: string;
  text: string;
  textSecondary: string;
  primary: string;
  primaryDark: string;
  border: string;
  success: string;
  warning: string;
  error: string;
}

function palette(theme: 'light' | 'dark', colorSchemeId: string = 'cyan'): Palette {
  const scheme = getScheme(colorSchemeId);
  if (theme === 'dark') {
    return {
      bg: '#0F1015',
      surface: '#661E2128',
      surfaceSolid: '#1E2128',
      text: '#E6E8EC',
      textSecondary: '#9CA3AF',
      primary: scheme.primary,
      primaryDark: scheme.primaryDark,
      border: '#222630',
      success: scheme.success,
      warning: scheme.warning,
      error: scheme.error
    };
  }
  return {
    bg: '#E8EBF0',
    surface: '#66FFFFFF',
    surfaceSolid: '#FFFFFF',
    text: '#1A1C20',
    textSecondary: '#59616E',
    primary: scheme.primary,
    primaryDark: scheme.primaryDark,
    border: '#0000000F',
    success: scheme.success,
    warning: scheme.warning,
    error: scheme.error
  };
}

function statusText(s: TaskStatus): string {
  switch (s) {
    case TaskStatus.Queued:
      return '排队中';
    case TaskStatus.Downloading:
      return '下载中';
    case TaskStatus.Paused:
      return '已暂停';
    case TaskStatus.Verifying:
      return '校验中';
    case TaskStatus.Completed:
      return '已完成';
    case TaskStatus.Error:
      return '错误';
    default:
      return '未知';
  }
}

@Entry
@ComponentV2
struct IndexPage {
  @Local vm: DownloadViewModel = new DownloadViewModel();
  navPathStack: NavPathStack = new NavPathStack();
  @Local currentTab: number = 0;
  private deepLinkTimer: number = -1;

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  aboutToAppear(): void {
    const context = getContext(this) as common.UIAbilityContext;
    this.vm.init(context);
    // Process any pending deep-link URL from cold start
    this.handlePendingDeepLink();
    // Poll for warm-start deep links (onNewWant updates AppStorage)
    this.deepLinkTimer = setInterval(() => {
      this.handlePendingDeepLink();
    }, 800);
  }

  aboutToDisappear(): void {
    if (this.deepLinkTimer >= 0) {
      clearInterval(this.deepLinkTimer);
      this.deepLinkTimer = -1;
    }
  }

  /** Check AppStorage for a pending download URL from deep link / share. */
  private handlePendingDeepLink(): void {
    const url = AppStorage.get<string>('pendingDownloadUrl');
    if (url && url.length > 0) {
      // Clear immediately to avoid re-processing
      AppStorage.setOrCreate<string>('pendingDownloadUrl', '');
      // Auto-add the download
      this.vm.addDownload(url).then(() => {
        promptAction.showToast({ message: '已从浏览器扩展接收链接，开始下载' });
      }).catch((e: Error) => {
        promptAction.showToast({ message: '链接接收失败: ' + (e?.message || String(e)) });
      });
    }
  }

  private async doExport(task: DownloadTask): Promise<void> {
    try {
      const path = await this.vm.exportToDownload(task);
      promptAction.showToast({ message: '已导出到公共 Download: ' + path });
    } catch (e) {
      promptAction.showToast({ message: '导出失败: ' + ((e as Error)?.message || String(e)) });
    }
  }

  get visibleTasks(): DownloadTask[] {
    if (this.currentTab === 0) {
      return this.vm.tasks.filter(t => t.status !== TaskStatus.Completed);
    }
    return this.vm.tasks.filter(t => t.status === TaskStatus.Completed);
  }

  build() {
    Navigation(this.navPathStack) {
      this.MasterView()
    }
    .title('FluxDown')
    .backgroundColor(this.p.bg)
    .mode(NavigationMode.Auto)
    .navBarWidth(360)
    .menus([
      {
        value: '新建下载',
        icon: $r('app.media.ic_add'),
        action: () => {
          this.navPathStack.pushPath({ name: 'add' });
        }
      },
      {
        value: '统计',
        icon: $r('app.media.ic_stats'),
        action: () => {
          this.navPathStack.pushPath({ name: 'stats' });
        }
      },
      {
        value: '设置',
        icon: $r('app.media.ic_settings'),
        action: () => {
          this.navPathStack.pushPath({ name: 'settings' });
        }
      }
    ])
    .navDestination(this.NavDest)
  }

  @Builder
  NavDest(name: string, param: Object) {
    if (name === 'detail') {
      NavDestination() {
        TaskDetailContent({ task: param as DownloadTask, vm: this.vm })
      }
      .title('任务详情')
      .mode(NavDestinationMode.STANDARD)
    } else if (name === 'add') {
      NavDestination() {
        AddContent({ vm: this.vm, navStack: this.navPathStack })
      }
      .title('新建下载')
      .mode(NavDestinationMode.STANDARD)
    } else if (name === 'settings') {
      NavDestination() {
        SettingsContent({ vm: this.vm, navStack: this.navPathStack })
      }
      .title('设置')
      .mode(NavDestinationMode.STANDARD)
    } else if (name === 'about') {
      NavDestination() {
        AboutContent({ vm: this.vm })
      }
      .title('关于')
      .mode(NavDestinationMode.STANDARD)
    } else if (name === 'stats') {
      NavDestination() {
        StatsContent({ vm: this.vm })
      }
      .title('下载统计')
      .mode(NavDestinationMode.STANDARD)
    }
  }

  @Builder
  MasterView() {
    Column() {
      Row() {
        this.TabButton('下载中', 0, '↓')
        this.TabButton('已完成', 1, '✓')
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })

      if (this.visibleTasks.length === 0) {
        Column() {
          Text('暂无下载任务').fontColor(this.p.textSecondary).fontSize(16)
          Text('点击右上角"新建下载"添加').fontColor(this.p.textSecondary).fontSize(13).margin({ top: 6 })
        }
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
        .transition(TransitionEffect.OPACITY.animation({ duration: 300, curve: Curve.EaseInOut }))
      } else {
        List() {
          ForEach(
            this.visibleTasks,
            (task: DownloadTask) => {
              ListItem() {
                this.TaskRow(task)
              }
              .onClick(() => {
                this.navPathStack.pushPath({ name: 'detail', param: task });
              })
              .transition(TransitionEffect.translate({ y: 20 }).combine(TransitionEffect.OPACITY)
                .animation({ duration: 300, curve: Curve.EaseOut }))
            },
            (task: DownloadTask) => task.id
          )
        }
        .layoutWeight(1)
        .width('100%')
        .divider({ strokeWidth: 1, color: this.p.border })
        .transition(TransitionEffect.OPACITY.animation({ duration: 300, curve: Curve.EaseInOut }))
        .edgeEffect(EdgeEffect.Spring)
      }
    }
    .width('100%')
  }

  @Builder
  TabButton(label: string, index: number, icon: string) {
    Row() {
      Text(icon)
        .fontSize(18)
        .fontColor(this.currentTab === index ? '#FFFFFF' : this.p.text)
      Text(label)
        .fontSize(14)
        .fontColor(this.currentTab === index ? '#FFFFFF' : this.p.text)
        .margin({ left: 6 })
    }
    .layoutWeight(1)
    .height(40)
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.currentTab === index ? this.p.primary : this.p.surface)
    .borderRadius(10)
    .margin({ left: 4, right: 4 })
    .animation({ duration: 250, curve: Curve.EaseInOut })
    .onClick(() => {
      this.currentTab = index;
    })
  }

  @Builder
  TaskRow(task: DownloadTask) {
    Row() {
      Column() {
        Row() {
          Text(task.fileName)
            .fontSize(15)
            .fontColor(this.p.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          Text(protocolMeta(task.protocol).label)
            .fontSize(10)
            .fontColor('#FFFFFF')
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .borderRadius(4)
            .backgroundColor(protocolMeta(task.protocol).color)
            .margin({ left: 8 })
        }
        .width('100%')
        Row() {
          Text(statusText(task.status)).fontSize(12).fontColor(this.p.textSecondary)
          if (task.status === TaskStatus.Downloading) {
            Text('  ' + formatSpeed(task.speed)).fontSize(12).fontColor(this.p.primaryDark)
          }
          Text(
            '  ' +
              formatBytes(task.downloadedBytes) +
              (task.totalBytes > 0 ? ' / ' + formatBytes(task.totalBytes) : '')
          )
            .fontSize(12)
            .fontColor(this.p.textSecondary)
        }
        .margin({ top: 4 })

        if (task.totalBytes > 0) {
          Progress({ value: task.percent, total: 100, type: ProgressType.Linear })
            .width('100%')
            .margin({ top: 6 })
        } else if (task.status === TaskStatus.Downloading) {
          Text('流式下载中…').fontSize(11).fontColor(this.p.textSecondary).margin({ top: 6 })
        }

        if (task.status === TaskStatus.Error) {
          Text(task.errorMessage)
            .fontSize(11)
            .fontColor(this.p.error)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 4 })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Row() {
        if (task.status === TaskStatus.Downloading) {
          Button('暂停')
            .height(32)
            .fontSize(12)
            .onClick(() => {
              this.vm.pause(task);
            })
        } else if (task.status === TaskStatus.Paused || task.status === TaskStatus.Error) {
          Button('继续')
            .height(32)
            .fontSize(12)
            .onClick(() => {
              this.vm.resume(task);
            })
        } else if (task.status === TaskStatus.Completed) {
          Button('导出')
            .height(32)
            .fontSize(12)
            .backgroundColor(this.p.primary)
            .fontColor('#FFFFFF')
            .onClick(() => {
              this.doExport(task);
            })
        }
        Button('删除')
          .height(32)
          .fontSize(12)
          .margin({ left: 6 })
          .onClick(() => {
            this.vm.remove(task);
          })
      }
    }
    .padding(12)
    .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
    .borderRadius(12)
    .margin({ left: 12, right: 12, top: 6, bottom: 6 })
  }
}

// ── 新建下载页面 ──
@ComponentV2
struct AddContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();
  @Param navStack: NavPathStack = new NavPathStack();
  @Local url: string = '';
  @Local autoFileName: string = '';
  @Local detectedLabel: string = '';
  @Local detectedColor: string = '';
  @Local detectedDesc: string = '';
  @Local detectedImpl: boolean = true;
  @Local hasDetection: boolean = false;
  @Local batchUrls: string = '';

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  @Builder
  ProtocolChip(label: string, color: string, implemented: boolean) {
    Text(label)
      .fontSize(11)
      .fontColor('#FFFFFF')
      .padding({ left: 8, right: 8, top: 4, bottom: 4 })
      .borderRadius(6)
      .backgroundColor(color)
  }

  build() {
    Column() {
      Text('下载链接')
        .fontSize(14)
        .fontColor(this.p.textSecondary)
        .width('100%')
        .margin({ bottom: 8 })

      TextInput({ placeholder: '粘贴或输入下载链接', text: this.url })
        .onChange((v: string) => {
          this.url = v;
          const trimmed = v.trim();
          if (trimmed.length > 0) {
            const meta = protocolMeta(detectProtocol(trimmed));
            this.detectedLabel = meta.label;
            this.detectedColor = meta.color;
            this.detectedDesc = meta.desc;
            this.detectedImpl = meta.implemented;
            this.hasDetection = true;
            this.autoFileName = fileNameFromUrl(trimmed);
          } else {
            this.hasDetection = false;
            this.autoFileName = '';
          }
        })
        .width('100%')
        .height(48)
        .borderRadius(10)

      // 实时协议检测徽章
      if (this.hasDetection) {
        Row() {
          Row() {
            Text('●').fontSize(10).fontColor(this.detectedColor).margin({ right: 4 })
            Text(this.detectedLabel).fontSize(12).fontColor(this.p.text)
            Text(this.detectedDesc).fontSize(11).fontColor(this.p.textSecondary).margin({ left: 6 })
          }
          .layoutWeight(1)

          if (!this.detectedImpl) {
            Text('未实现').fontSize(10).fontColor('#DC2626')
          }
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(8)
        .margin({ top: 8 })
      }

      // 自动识别文件名预览
      if (this.autoFileName.length > 0) {
        Row() {
          Text('文件名').fontSize(13).fontColor(this.p.textSecondary)
          Text(this.autoFileName)
            .fontSize(13)
            .fontColor(this.p.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .margin({ left: 8 })
        }
        .width('100%')
        .margin({ top: 12 })
      }

      // 支持协议标签
      Text('支持协议')
        .fontSize(13)
        .fontColor(this.p.textSecondary)
        .width('100%')
        .margin({ top: 20, bottom: 8 })

      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(ALL_PROTOCOLS, (proto: ProtocolType) => {
          this.ProtocolChip(
            protocolMeta(proto).label,
            protocolMeta(proto).color,
            protocolMeta(proto).implemented
          )
        })
      }
      .width('100%')

      Button('开始下载')
        .width('100%')
        .height(48)
        .backgroundColor(this.p.primary)
        .fontColor('#FFFFFF')
        .borderRadius(10)
        .margin({ top: 24 })
        .enabled(this.url.trim().length > 0)
        .onClick(() => {
          if (this.url.trim().length === 0) {
            return;
          }
          this.vm.addDownload(this.url.trim(), undefined);
          this.url = '';
          this.autoFileName = '';
          this.hasDetection = false;
          promptAction.showToast({ message: '已添加下载任务' });
          this.navStack.pop();
        })

      // ── 批量下载 ──
      Divider().color(this.p.border).margin({ top: 24, bottom: 16 })

      Text('批量下载').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        .margin({ bottom: 8 })
      Text('每行一个 URL（仅支持 http/https）').fontSize(12).fontColor(this.p.textSecondary)
        .margin({ bottom: 8 })

      TextArea({ text: this.batchUrls, placeholder: 'https://example.com/file1.zip\nhttps://example.com/file2.zip' })
        .width('100%')
        .height(120)
        .fontSize(13)
        .backgroundColor(this.p.bg)
        .borderRadius(8)
        .onChange((v: string) => { this.batchUrls = v; })

      Button('批量添加')
        .width('100%')
        .height(44)
        .backgroundColor(this.p.surfaceSolid)
        .fontColor(this.p.text)
        .borderRadius(10)
        .margin({ top: 12 })
        .enabled(this.batchUrls.trim().length > 0)
        .onClick(() => {
          const urls = this.batchUrls.split('\n').map(u => u.trim()).filter(u => u.length > 0);
          this.vm.addBatchDownloads(urls).then((n: number) => {
            promptAction.showToast({ message: `已添加 ${n} 个下载` });
            this.batchUrls = '';
            this.navStack.pop();
          });
        })
    }
    .padding(20)
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .alignItems(HorizontalAlign.Start)
  }
}

// ── 设置页面 ──
@ComponentV2
struct SettingsContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();
  @Param navStack: NavPathStack = new NavPathStack();
  @Local rssUrl: string = '';
  @Local rssName: string = '';
  @Local rssFilter: string = '';

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  build() {
    Scroll() {
      Column() {
        // ── 关于入口 ──
        Row() {
          Text('关于').fontColor(this.p.text).layoutWeight(1).fontSize(16)
          Text('›').fontColor(this.p.textSecondary).fontSize(20)
        }
        .width('100%')
        .padding(16)
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(12)
        .margin({ left: 16, right: 16, top: 16 })
        .onClick(() => {
          this.navStack.pushPath({ name: 'about' });
        })

        // ── 下载设置 ──
        Text('下载设置').fontSize(13).fontColor(this.p.textSecondary)
          .margin({ left: 20, top: 24, bottom: 6 })
          .width('100%')

        Column() {
          Row() {
            Text('最大线程数').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Text(String(this.vm.maxSegments)).fontColor(this.p.primaryDark).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 6 })

          Slider({
            value: this.vm.maxSegments,
            min: 1,
            max: 16,
            step: 1,
            style: SliderStyle.OutSet
          })
            .onChange((v: number) => {
              this.vm.setMaxSegments(v);
            })
            .width('100%')
            .padding({ left: 12, right: 12, bottom: 8 })
            .blockColor(this.p.primary)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Text('校验完整性').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.verifyIntegrity, type: ToggleType.Switch })
              .onChange((v: boolean) => {
                this.vm.setVerify(v);
              })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Text('自动导出到公共 Download').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.autoExport, type: ToggleType.Switch })
              .onChange((v: boolean) => {
                this.vm.setAutoExport(v);
              })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 全局限速
          Row() {
            Text('全局限速').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Text(this.vm.globalSpeedLimit > 0 ? formatSpeed(this.vm.globalSpeedLimit) : '不限')
              .fontColor(this.p.primaryDark).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 6 })

          Slider({
            value: this.vm.globalSpeedLimit > 0 ? Math.log10(this.vm.globalSpeedLimit / 1024) : 0,
            min: 0,
            max: 4,
            step: 0.1,
            style: SliderStyle.OutSet
          })
            .onChange((v: number) => {
              this.vm.setGlobalSpeedLimit(v > 0 ? Math.round(Math.pow(10, v) * 1024) : 0);
            })
            .width('100%')
            .padding({ left: 12, right: 12, bottom: 8 })
            .blockColor(this.p.primary)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 代理
          Column() {
            Text('代理地址').fontColor(this.p.textSecondary).fontSize(13)
            TextInput({ text: this.vm.proxyUrl, placeholder: 'http://host:port 或留空' })
              .onChange((v: string) => { this.vm.setProxyUrl(v); })
              .width('100%')
              .margin({ top: 8 })
              .backgroundColor(this.p.bg)
              .borderRadius(8)
          }
          .width('100%')
          .padding(16)
          .alignItems(HorizontalAlign.Start)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 剪贴板监听
          Row() {
            Text('剪贴板监听').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.clipboardMonitor, type: ToggleType.Switch })
              .onChange((v: boolean) => { this.vm.setClipboardMonitor(v); })
          }
          .width('100%')
          .padding(16)
        }
        .width('100%')
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(12)
        .margin({ left: 16, right: 16 })

        // ── 外观 ──
        Text('外观').fontSize(13).fontColor(this.p.textSecondary)
          .margin({ left: 20, top: 24, bottom: 6 })
          .width('100%')

        Column() {
          Row() {
            Text('主题').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Button(this.vm.theme === 'dark' ? '深色' : '浅色')
              .fontSize(13)
              .backgroundColor(this.vm.theme === 'dark' ? '#3A3D45' : '#E0E0E0')
              .fontColor(this.p.text)
              .onClick(() => {
                this.vm.setTheme(this.vm.theme === 'dark' ? 'light' : 'dark');
              })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Text('配色').fontColor(this.p.text).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, top: 12, bottom: 4 })

          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(COLOR_SCHEMES, (scheme: ColorScheme) => {
              Column() {
                Column()
                  .width(36)
                  .height(36)
                  .borderRadius(18)
                  .backgroundColor(scheme.primary)
                  .border({
                    width: this.vm.colorScheme === scheme.id ? 3 : 0,
                    color: this.p.text
                  })
              }
              .margin(8)
              .onClick(() => { this.vm.setColorScheme(scheme.id); })
            })
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 16 })
        }
        .width('100%')
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(12)
        .margin({ left: 16, right: 16 })

        // ── MCP 服务 ──
        Text('MCP 服务').fontSize(13).fontColor(this.p.textSecondary)
          .margin({ left: 20, top: 24, bottom: 6 })
          .width('100%')

        Column() {
          Row() {
            Column() {
              Text('MCP 本地服务').fontColor(this.p.text).fontSize(15)
              Text('127.0.0.1:17800').fontColor(this.p.textSecondary).fontSize(12).margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            Toggle({ isOn: this.vm.mcpEnabled, type: ToggleType.Switch })
              .onChange((v: boolean) => {
                this.vm.setMcp(v);
              })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Column() {
            Text('Bearer Token').fontColor(this.p.textSecondary).fontSize(13)
            TextInput({ text: this.vm.mcpToken })
              .onChange((v: string) => {
                this.vm.setMcpToken(v);
              })
              .width('100%')
              .margin({ top: 8 })
              .backgroundColor(this.p.bg)
              .borderRadius(8)
          }
          .width('100%')
          .padding(16)
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(12)
        .margin({ left: 16, right: 16 })

        // ── 浏览器扩展 ──
        Text('浏览器扩展').fontSize(13).fontColor(this.p.textSecondary)
          .margin({ left: 20, top: 24, bottom: 6 })
          .width('100%')

        Column() {
          Row() {
            Text('深度链接协议').fontColor(this.p.textSecondary).fontSize(13).layoutWeight(1)
            Text('fluxdown://').fontColor(this.p.primary).fontSize(13).fontFamily('monospace')
          }
          .width('100%')
          .padding({ left: 16, top: 14, bottom: 8 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Column() {
              Text('安装方式').fontColor(this.p.text).fontSize(15)
              Text('在浏览器打开 chrome://extensions，开启「开发者模式」，点击「加载已解压的扩展程序」并选择 browser-extension 目录')
                .fontColor(this.p.textSecondary).fontSize(12).margin({ top: 6 })
            }
            .alignItems(HorizontalAlign.Start).layoutWeight(1)
          }
          .width('100%')
          .padding(16)
        }
        .width('100%')
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(12)
        .margin({ left: 16, right: 16 })

        // ── RSS 订阅 ──
        Row() {
          Image($r('app.media.ic_rss'))
            .width(18)
            .height(18)
            .fillColor(this.p.primary)
            .margin({ right: 8 })
          Text('RSS 订阅')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.p.textSecondary)
            .layoutWeight(1)
        }
        .width('100%')
        .margin({ left: 16, top: 24, bottom: 8 })

        Column() {
          TextInput({ text: this.rssUrl, placeholder: 'RSS 订阅地址' })
            .fontSize(14)
            .onChange((v: string) => { this.rssUrl = v; })
          TextInput({ text: this.rssName, placeholder: '名称' })
            .fontSize(14)
            .margin({ top: 8 })
            .onChange((v: string) => { this.rssName = v; })
          TextInput({ text: this.rssFilter, placeholder: '关键词过滤 (逗号分隔)' })
            .fontSize(14)
            .margin({ top: 8 })
            .onChange((v: string) => { this.rssFilter = v; })
          Button('添加订阅')
            .fontSize(14)
            .backgroundColor(this.p.primary)
            .fontColor('#FFFFFF')
            .width('100%')
            .margin({ top: 8 })
            .onClick(() => {
              if (this.rssUrl.trim().length > 0 && this.rssName.trim().length > 0) {
                this.vm.addRss(this.rssUrl.trim(), this.rssName.trim(), this.rssFilter.trim());
                this.rssUrl = '';
                this.rssName = '';
                this.rssFilter = '';
              }
            })
        }
        .width('100%')
        .padding(16)
        .backgroundColor(this.p.surface)
        .borderRadius(12)
        .margin({ left: 16, right: 16, bottom: 12 })

        Button('立即检查所有订阅')
          .fontSize(14)
          .backgroundColor(this.p.primary)
          .fontColor('#FFFFFF')
          .width('80%')
          .margin({ bottom: 12 })
          .onClick(() => {
            this.vm.pollRss().then((n: number) => {
              promptAction.showToast({ message: `新增 ${n} 个下载` });
            });
          })

        ForEach(this.vm.rssSubs, (sub: RssSubscription) => {
          Column() {
            Row() {
              Text(sub.name).fontSize(16).fontColor(this.p.text).layoutWeight(1)
              Toggle({ type: ToggleType.Switch, isOn: sub.enabled })
                .onChange((on: boolean) => { this.vm.toggleRss(sub.id, on); })
            }
            .width('100%')
            .padding(12)

            Text(sub.url).fontSize(12).fontColor(this.p.textSecondary).maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .padding({ left: 12, right: 12 })

            Row() {
              Text(sub.filter ? `过滤: ${sub.filter}` : '无过滤').fontSize(11).fontColor(this.p.textSecondary).layoutWeight(1)
              Text(`已下载: ${sub.downloadedUrls.length}`).fontSize(11).fontColor(this.p.textSecondary)
            }
            .width('100%')
            .padding({ left: 12, right: 12, bottom: 12 })

            Button('删除')
              .fontSize(12)
              .backgroundColor(this.p.error)
              .fontColor('#FFFFFF')
              .margin({ left: 12, right: 12, bottom: 12 })
              .onClick(() => { this.vm.removeRss(sub.id); })
          }
          .width('100%')
          .backgroundColor(this.p.surface)
          .borderRadius(12)
          .margin({ left: 16, right: 16, bottom: 8 })
        })

      }
      .width('100%')
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .edgeEffect(EdgeEffect.Spring)
  }
}

// ── 关于页面 ──
@ComponentV2
struct AboutContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  build() {
    Scroll() {
      Column() {
        // App icon & name
        Column() {
          Image($r('app.media.app_icon'))
            .width(80)
            .height(80)
            .borderRadius(20)
            .margin({ bottom: 12 })

          Text('FluxDown')
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.p.text)

          Text('v1.0.0')
            .fontSize(14)
            .fontColor(this.p.textSecondary)
            .margin({ top: 4 })
        }
        .width('100%')
        .padding({ top: 36, bottom: 28 })
        .alignItems(HorizontalAlign.Center)

        // 简介
        Column() {
          Text('简介')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.p.textSecondary)
            .width('100%')
            .margin({ bottom: 10 })

          Text('FluxDown 是一款多协议下载管理器，支持 HTTP/HTTPS、FTP、HLS 流媒体、BitTorrent P2P 及 eD2K 协议。基于 HarmonyOS NEXT 原生开发，提供流畅的下载体验与任务管理功能。')
            .fontSize(14)
            .fontColor(this.p.text)
            .lineHeight(22)
            .width('100%')
        }
        .width('100%')
        .padding(16)
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(12)
        .margin({ left: 16, right: 16, bottom: 12 })

        // 支持协议
        Column() {
          Text('支持协议')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.p.textSecondary)
            .width('100%')
            .margin({ bottom: 12 })

          this.ProtocolItem('HTTP / HTTPS', '网页直链下载，支持多线程分片')
          this.ProtocolItem('FTP', '文件传输协议，被动模式')
          this.ProtocolItem('SFTP', 'SSH 文件传输协议（开发中）')
          this.ProtocolItem('HLS (m3u8)', 'HTTP Live Streaming 流媒体分段下载')
          this.ProtocolItem('BitTorrent', 'P2P 下载，磁力链接 / .torrent 种子')
          this.ProtocolItem('迅雷 (thunder://)', '迅雷专用链接（开发中）')
          this.ProtocolItem('eD2K', 'eDonkey 网络（开发中）')
        }
        .width('100%')
        .padding(16)
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(12)
        .margin({ left: 16, right: 16, bottom: 16 })

        // ── 作者 ──
        Column() {
          Row() {
            Image('https://avatars.githubusercontent.com/zerx-lab?v=4')
              .width(40)
              .height(40)
              .borderRadius(20)
            Column() {
              Text('原开发').fontSize(12).fontColor(this.p.textSecondary)
              Text('zerx-lab').fontSize(14).fontColor(this.p.text).fontWeight(FontWeight.Medium)
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
            .margin({ left: 12 })
          }
          .width('100%')
          .onClick(() => {
            const want: Want = { uri: 'https://github.com/zerx-lab' };
            (getContext(this) as common.UIAbilityContext).startAbility(want);
          })

          Divider().color(this.p.border).strokeWidth(1).margin({ top: 12, bottom: 12 })

          Row() {
            Image('https://avatars.githubusercontent.com/Pkeji?v=4')
              .width(40)
              .height(40)
              .borderRadius(20)
            Column() {
              Text('移植开发').fontSize(12).fontColor(this.p.textSecondary)
              Text('Pkeji').fontSize(14).fontColor(this.p.text).fontWeight(FontWeight.Medium)
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
            .margin({ left: 12 })
          }
          .width('100%')
          .onClick(() => {
            const want: Want = { uri: 'https://github.com/Pkeji' };
            (getContext(this) as common.UIAbilityContext).startAbility(want);
          })
        }
        .width('100%')
        .padding(16)
        .backgroundColor(this.p.surface)
        .backgroundBlurStyle(BlurStyle.COMPONENT_REGULAR)
        .borderRadius(12)
        .margin({ left: 16, right: 16, bottom: 16 })

        Text('© 2026 FluxDown for HarmonyOS')
          .fontSize(12)
          .fontColor(this.p.textSecondary)
          .margin({ bottom: 32 })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Center)
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .edgeEffect(EdgeEffect.Spring)
  }

  @Builder
  ProtocolItem(name: string, desc: string) {
    Row() {
      Text('•').fontSize(14).fontColor(this.p.primaryDark).margin({ right: 8 })
      Column() {
        Text(name).fontSize(13).fontColor(this.p.text).fontWeight(FontWeight.Medium)
        Text(desc).fontSize(12).fontColor(this.p.textSecondary).margin({ top: 2 })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .margin({ bottom: 8 })
  }
}

// ── 任务详情页面 ──
@ComponentV2
struct TaskDetailContent {
  @Param task: DownloadTask = new DownloadTask();
  @Param vm: DownloadViewModel = new DownloadViewModel();

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  build() {
    Column() {
      Row() {
        Text(this.task.fileName).fontSize(18).fontColor(this.p.text).fontWeight(FontWeight.Medium)
      }
      .width('100%')
      .padding(12)

      List() {
        this.Row2('状态', statusText(this.task.status))
        this.Row2('协议', protocolMeta(this.task.protocol).label + ' · ' + protocolMeta(this.task.protocol).desc)
        this.Row2('文件名', this.task.fileName)
        this.Row2('大小', this.task.totalBytes > 0 ? formatBytes(this.task.totalBytes) : '未知')
        this.Row2('已下载', formatBytes(this.task.downloadedBytes))
        this.Row2('进度', this.task.totalBytes > 0 ? this.task.percent + '%' : '-')
        this.Row2('速度', formatSpeed(this.task.speed))
        this.Row2('分片数', String(this.task.segments.length))
        if (this.task.sha256) {
          this.Row2('SHA-256', this.task.sha256)
        }
        this.Row2('链接', this.task.url)
        if (this.task.status === TaskStatus.Error) {
          this.Row2('错误', this.task.errorMessage)
        }
      }
      .layoutWeight(1)
      .width('100%')
      .divider({ strokeWidth: 1, color: this.p.border })
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
  }

  @Builder
  Row2(k: string, v: string) {
    ListItem() {
      Row() {
        Text(k).fontSize(13).fontColor(this.p.textSecondary).width('30%')
        Text(v)
          .fontSize(13)
          .fontColor(this.p.text)
          .layoutWeight(1)
          .maxLines(3)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .padding(10)
      .width('100%')
    }
  }
}

// ── 下载队列页面 ──
// ── 下载统计页面 ──
@ComponentV2
struct StatsContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  build() {
    Scroll() {
      Column() {
        Column() {
          Text('下载概览').fontSize(18).fontWeight(FontWeight.Bold).fontColor(this.p.text)
            .margin({ bottom: 16 })

          this.StatRow('总任务数', `${this.vm.getStats().totalTasks}`)
          this.StatRow('下载中', `${this.vm.getStats().activeCount}`)
          this.StatRow('已完成', `${this.vm.getStats().completedCount}`)
          this.StatRow('已暂停', `${this.vm.getStats().pausedCount}`)
          this.StatRow('错误', `${this.vm.getStats().errorCount}`)
          this.StatRow('已下载', formatBytes(this.vm.getStats().totalDownloaded))
          this.StatRow('总大小', formatBytes(this.vm.getStats().totalSize))
          this.StatRow('当前速度', formatSpeed(this.vm.getStats().currentSpeed))
          this.StatRow('平均速度', formatSpeed(this.vm.getStats().avgSpeed))
          this.StatRow('完成率', `${this.vm.getStats().completionRate.toFixed(1)}%`)
          this.StatRow('预计剩余',
            this.vm.getStats().estimatedTimeRemaining > 0 ?
            `${Math.ceil(this.vm.getStats().estimatedTimeRemaining)}秒` : '未知')
        }
        .width('100%')
        .padding(20)
        .backgroundColor(this.p.surface)
        .borderRadius(12)
        .margin({ left: 16, right: 16, bottom: 16 })

        // Category breakdown
        Column() {
          Text('分类统计').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.p.text)
            .margin({ bottom: 12 })
          ForEach(this.vm.getCategories(), (cat: string) => {
            Row() {
              Text(cat).fontSize(13).fontColor(this.p.text).layoutWeight(1)
              Text(`${this.vm.tasks.filter(t => t.category === cat).length} 个`)
                .fontSize(13).fontColor(this.p.textSecondary)
            }
            .width('100%')
            .padding(8)
          })
        }
        .width('100%')
        .padding(16)
        .backgroundColor(this.p.surface)
        .borderRadius(12)
        .margin({ left: 16, right: 16 })
      }
      .width('100%')
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .edgeEffect(EdgeEffect.Spring)
  }

  @Builder
  StatRow(label: string, value: string) {
    Row() {
      Text(label).fontSize(13).fontColor(this.p.textSecondary).width('40%')
      Text(value).fontSize(14).fontColor(this.p.text).layoutWeight(1)
    }
    .width('100%')
    .padding(8)
  }
}
