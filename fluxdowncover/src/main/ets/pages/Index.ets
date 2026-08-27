import { promptAction } from '@kit.ArkUI';
import { common, Want, OpenLinkOptions } from '@kit.AbilityKit';
import { picker, fileUri } from '@kit.CoreFileKit';
import { wantConstant } from '@kit.AbilityKit';

import { DownloadViewModel } from '../viewmodel/DownloadViewModel';
import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';
import { formatBytes, formatSpeed, formatDateTime, formatDuration, detectProtocol, protocolMeta, ALL_PROTOCOLS, fileNameFromUrl, ProtocolMeta } from '../utils/common';
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
  @Local selectMode: boolean = false;
  @Local selectedTaskIds: Set<string> = new Set();
  private deepLinkTimer: number = -1;
  private contextMenuTask: DownloadTask | null = null;

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
        if (!this.vm.duplicatePrompt) {
          promptAction.showToast({ message: '已从浏览器扩展接收链接，开始下载' });
        }
      }).catch((e: Error) => {
        promptAction.showToast({ message: '链接接收失败: ' + (e?.message || String(e)) });
      });
    }
  }

  private async openFile(task: DownloadTask): Promise<void> {
    try {
      // Ensure file is exported first
      if (!task.publicPath) {
        await this.vm.exportToDownload(task);
      }
      const fileUriObj = fileUri.getUriFromPath(task.publicPath);
      const want: Want = {
        action: 'ohos.want.action.viewData',
        uri: fileUriObj,
        flags: wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION | wantConstant.Flags.FLAG_AUTH_WRITE_URI_PERMISSION,
      };
      (getContext(this) as common.UIAbilityContext).startAbility(want);
    } catch (e) {
      promptAction.showToast({ message: '打开文件失败: ' + ((e as Error)?.message || String(e)) });
    }
  }

  private async openFileLocation(task: DownloadTask): Promise<void> {
    try {
      if (!task.publicPath) {
        await this.vm.exportToDownload(task);
      }
      // Use openLink to open the system file manager at the file's directory
      const fileUriObj = fileUri.getUriFromPath(task.publicPath);
      const ctx = getContext(this) as common.UIAbilityContext;
      ctx.openLink('filemanager://openDirectory', {
        parameters: { 'fileUri': fileUriObj }
      } as OpenLinkOptions);
    } catch (e) {
      promptAction.showToast({ message: '打开文件目录失败: ' + ((e as Error)?.message || String(e)) });
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
    .title('FluxDown Cover')
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
        AddContent({ vm: this.vm, navStack: this.navPathStack, onDownloadStart: () => { this.currentTab = 0; } })
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
        Blank()
        if (this.visibleTasks.length > 0) {
          Text(this.selectMode ? '取消' : '选择')
            .fontSize(14)
            .fontColor(this.p.primary)
            .onClick(() => {
              this.selectMode = !this.selectMode;
              if (!this.selectMode) {
                this.selectedTaskIds = new Set();
              }
            })
        }
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
                if (this.selectMode) {
                  const s = new Set(this.selectedTaskIds);
                  if (s.has(task.id)) {
                    s.delete(task.id);
                  } else {
                    s.add(task.id);
                  }
                  this.selectedTaskIds = s;
                } else {
                  this.navPathStack.pushPath({ name: 'detail', param: task });
                }
              })
              .onMouse((event: MouseEvent) => {
                if (event.button === MouseButton.Right) {
                  this.contextMenuTask = task;
                }
              })
              .bindContextMenu(this.selectMode ? undefined : this.RightClickMenu, ResponseType.RightClick)
              .swipeAction(this.selectMode ? undefined : {
                end: {
                  builder: () => {
                    this.SwipeActionForTask(task);
                  },
                  actionAreaDistance: 56
                }
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

      // ── 选择模式底部操作栏 ──
      if (this.selectMode) {
        Row() {
          Text(`已选 ${this.selectedTaskIds.size} 项`)
            .fontSize(14)
            .fontColor(this.p.text)
          Blank()
          Button(this.selectedTaskIds.size === this.visibleTasks.length ? '取消全选' : '全选')
            .type(ButtonType.Capsule)
            .fontSize(13)
            .backgroundColor(this.p.surface)
            .fontColor(this.p.primary)
            .height(36)
            .onClick(() => {
              if (this.selectedTaskIds.size === this.visibleTasks.length) {
                this.selectedTaskIds = new Set();
              } else {
                this.selectedTaskIds = new Set(this.visibleTasks.map(t => t.id));
              }
            })
          Button(`删除${this.selectedTaskIds.size > 0 ? `(${this.selectedTaskIds.size})` : ''}`)
            .type(ButtonType.Capsule)
            .fontSize(13)
            .backgroundColor('#E8553B')
            .fontColor('#FFFFFF')
            .enabled(this.selectedTaskIds.size > 0)
            .height(36)
            .margin({ left: 8 })
            .onClick(() => {
              if (this.selectedTaskIds.size === 0) {
                return;
              }
              const count = this.selectedTaskIds.size;
              AlertDialog.show(
                {
                  title: '批量删除',
                  message: `确定要删除选中的 ${count} 个下载任务吗？\n相关文件将被同时删除。`,
                  autoCancel: true,
                  alignment: DialogAlignment.Center,
                  primaryButton: {
                    value: '取消',
                    action: () => {}
                  },
                  secondaryButton: {
                    value: '删除',
                    fontColor: '#FF3B30',
                    action: () => {
                      const ids = Array.from(this.selectedTaskIds);
                      this.vm.removeTasks(ids);
                      this.selectedTaskIds = new Set();
                      this.selectMode = false;
                    }
                  }
                }
              );
            })
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 8, bottom: 8 })
        .backgroundColor(this.p.surface)
        .borderRadius({ topLeft: 12, topRight: 12 })
        .margin({ left: 12, right: 12, bottom: 6 })
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
      this.selectMode = false;
      this.selectedTaskIds = new Set();
    })
  }

  @Builder
  RightClickMenu() {
    if (this.contextMenuTask?.status === TaskStatus.Completed) {
      Menu() {
        MenuItem({ content: '打开文件' })
          .onChange(() => {
            this.openFile(this.contextMenuTask!);
          })
        MenuItem({ content: '打开文件所在目录' })
          .onChange(() => {
            this.openFileLocation(this.contextMenuTask!);
          })
        MenuItem({ content: '删除' })
          .onChange(() => {
            AlertDialog.show(
              {
                title: '删除任务',
                message: '确定要删除此下载任务吗？\n相关文件将被同时删除。',
                autoCancel: true,
                alignment: DialogAlignment.Center,
                primaryButton: {
                  value: '取消',
                  action: () => {}
                },
                secondaryButton: {
                  value: '删除',
                  fontColor: '#FF3B30',
                  action: () => {
                    this.vm.remove(this.contextMenuTask!);
                  }
                }
              }
            );
          })
      }
    }
  }

  @Builder
  SwipeActionForTask(task: DownloadTask) {
    Row() {
      if (task.status === TaskStatus.Downloading) {
        Button() {
          Text('暂停').fontSize(13).fontColor('#FFFFFF')
        }
        .type(ButtonType.Capsule)
        .backgroundColor('#FFA940')
        .width(60)
        .height(40)
        .margin({ right: 6 })
        .onClick(() => {
          this.vm.pause(task);
        })
      } else if (task.status === TaskStatus.Paused || task.status === TaskStatus.Error) {
        Button() {
          Text('继续').fontSize(13).fontColor('#FFFFFF')
        }
        .type(ButtonType.Capsule)
        .backgroundColor('#52C41A')
        .width(60)
        .height(40)
        .margin({ right: 6 })
        .onClick(() => {
          this.vm.resume(task);
        })
      } else if (task.status === TaskStatus.Completed) {
        Button() {
          Text('打开文件').fontSize(13).fontColor('#FFFFFF')
        }
        .type(ButtonType.Capsule)
        .backgroundColor('#007DFF')
        .width(76)
        .height(40)
        .margin({ right: 6 })
        .onClick(() => {
          this.openFile(task);
        })
        Button() {
          Text('打开位置').fontSize(13).fontColor('#FFFFFF')
        }
        .type(ButtonType.Capsule)
        .backgroundColor('#666C78')
        .width(76)
        .height(40)
        .margin({ right: 6 })
        .onClick(() => {
          this.openFileLocation(task);
        })
      }
      Button() {
        Text('删除').fontSize(13).fontColor('#FFFFFF')
      }
      .type(ButtonType.Capsule)
      .backgroundColor('#E8553B')
      .width(60)
      .height(40)
      .onClick(() => {
        AlertDialog.show(
          {
            title: '删除任务',
            message: '确定要删除此下载任务吗？\n相关文件将被同时删除。',
            autoCancel: true,
            alignment: DialogAlignment.Center,
            primaryButton: {
              value: '取消',
              action: () => {}
            },
            secondaryButton: {
              value: '删除',
              fontColor: '#FF3B30',
              action: () => {
                this.vm.remove(task);
              }
            }
          }
        );
      })
    }
    .height('100%')
    .padding({ left: 8, right: 8 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  TaskRow(task: DownloadTask) {
    Row() {
      if (this.selectMode) {
        Checkbox()
          .select(this.selectedTaskIds.has(task.id))
          .shape(CheckBoxShape.ROUNDED_SQUARE)
          .width(22)
          .height(22)
          .margin({ right: 10 })
          .onChange((isChecked: boolean) => {
            const s = new Set(this.selectedTaskIds);
            if (isChecked) {
              s.add(task.id);
            } else {
              s.delete(task.id);
            }
            this.selectedTaskIds = s;
          })
      }
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

      // 所有操作移至左滑菜单
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
  @Param onDownloadStart: () => void = (): void => {};
  @Local url: string = '';
  @Local autoFileName: string = '';
  @Local detectedLabel: string = '';
  @Local detectedColor: string = '';
  @Local detectedDesc: string = '';
  @Local detectedImpl: boolean = true;
  @Local hasDetection: boolean = false;
  @Local batchUrls: string = '';
  @Local selectedTorrentPath: string = '';

  /** Open system file picker to select a .torrent file. */
  async pickTorrentFile(): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const documentPicker = new picker.DocumentViewPicker(context);
      const options = new picker.DocumentSelectOptions();
      // Filter for .torrent files
      options.fileSuffixFilters = ['.torrent'];
      const results = await documentPicker.select(options);
      if (results && results.length > 0) {
        const uri = results[0];
        this.selectedTorrentPath = uri;
        this.url = uri;
        // Auto-detect protocol
        const trimmed = uri.trim();
        if (trimmed.length > 0) {
          const meta = protocolMeta(detectProtocol(trimmed));
          this.detectedLabel = meta.label;
          this.detectedColor = meta.color;
          this.detectedDesc = meta.desc;
          this.detectedImpl = meta.implemented;
          this.hasDetection = true;
          this.autoFileName = fileNameFromUrl(trimmed) || uri.split('/').pop() || '';
        }
        promptAction.showToast({ message: '已选择种子文件' });
      }
    } catch (e) {
      promptAction.showToast({ message: '选择文件失败: ' + (e as Error).message });
    }
  }

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

  /** 检测到重复下载链接时弹出询问对话框。 */
  private showDuplicateDialog(): void {
    const info = this.vm.duplicatePrompt;
    if (!info) {
      return;
    }
    AlertDialog.show({
      title: '重复下载',
      message: `链接「${info.url.length > 60 ? info.url.slice(0, 57) + '...' : info.url}」\n已存在下载任务，是否重新下载？原文件将保留。`,
      autoCancel: false,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '跳过',
        action: () => {
          this.vm.confirmDuplicateDownload('skip');
        }
      },
      secondaryButton: {
        value: '重新下载',
        fontColor: '#007AFF',
        action: () => {
          this.vm.confirmDuplicateDownload('redownload');
          promptAction.showToast({ message: '已重新添加下载任务' });
          this.onDownloadStart?.();
          this.navStack.pop();
        }
      }
    });
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

      // 选择种子文件
      Row() {
        Button('📂 选择 .torrent 种子文件')
          .fontSize(13)
          .height(40)
          .backgroundColor(this.p.surfaceSolid)
          .fontColor(this.p.text)
          .borderRadius(8)
          .onClick(() => {
            this.pickTorrentFile();
          })
        if (this.selectedTorrentPath.length > 0) {
          Text('已选择: ' + this.selectedTorrentPath.split('/').pop())
            .fontSize(11)
            .fontColor(this.p.success)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .margin({ left: 8 })
        }
      }
      .width('100%')
      .margin({ top: 12 })

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
          if (this.vm.duplicatePrompt) {
            this.showDuplicateDialog();
            return;
          }
          this.url = '';
          this.autoFileName = '';
          this.hasDetection = false;
          promptAction.showToast({ message: '已添加下载任务' });
          this.onDownloadStart?.();
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
            this.onDownloadStart?.();
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
            max: 32,
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

          Text('FluxDown Cover')
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.p.text)

          Text('v1.1.3')
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

          Text('FluxDown Cover 是一款多协议下载管理器，支持 HTTP/HTTPS、FTP、HLS/DASH 流媒体、BitTorrent P2P、eD2K 网络及迅雷/快车/旋风专用链接。基于 HarmonyOS NEXT 原生开发，提供流畅的下载体验与任务管理功能。')
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

          ForEach(ALL_PROTOCOLS, (pt: ProtocolType) => {
            this.ProtocolItem(protocolMeta(pt))
          }, (pt: ProtocolType) => pt)
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

        Text('© 2026 FluxDown Cover for HarmonyOS')
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
  ProtocolItem(meta: ProtocolMeta) {
    Row() {
      // Colored dot indicating protocol
      Circle({ width: 8, height: 8 })
        .fill(meta.color)
        .margin({ right: 10 })

      Column() {
        Row() {
          Text(meta.label).fontSize(13).fontColor(this.p.text).fontWeight(FontWeight.Medium)
          if (!meta.implemented) {
            Text('开发中')
              .fontSize(10)
              .fontColor('#FFFFFF')
              .backgroundColor('#9E9E9E')
              .borderRadius(4)
              .padding({ left: 6, right: 6, top: 2, bottom: 2 })
              .margin({ left: 8 })
          }
        }
        Text(meta.fullDesc).fontSize(12).fontColor(this.p.textSecondary).margin({ top: 2 })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .margin({ bottom: 10 })
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
        this.Row2('速度', formatSpeed(this.task.status === TaskStatus.Completed ? this.task.peakSpeed : this.task.speed))
        this.Row2('分片数', String(this.task.segments.length))
        this.Row2('创建时间', formatDateTime(this.task.createdAt))
        if (this.task.finishedAt > 0) {
          this.Row2('完成时间', formatDateTime(this.task.finishedAt))
          this.Row2('下载耗时', formatDuration(this.task.finishedAt - this.task.createdAt))
        }
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
