import { promptAction } from '@kit.ArkUI';
import { DownloadViewModel } from '../viewmodel/DownloadViewModel';
import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';
import { formatBytes, formatSpeed } from '../utils/common';

interface Palette {
  bg: string;
  surface: string;
  text: string;
  textSecondary: string;
  primary: string;
  border: string;
}

function palette(theme: 'light' | 'dark'): Palette {
  if (theme === 'dark') {
    return {
      bg: '#15171C',
      surface: '#1E2128',
      text: '#E6E8EC',
      textSecondary: '#9CA3AF',
      primary: '#60A5FA',
      border: '#2A2E37'
    };
  }
  return {
    bg: '#F2F4F8',
    surface: '#FFFFFF',
    text: '#1A1C20',
    textSecondary: '#6B7280',
    primary: '#3B82F6',
    border: '#E5E7EB'
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
      return '等待';
  }
}

@Entry
@ComponentV2
struct IndexPage {
  @Local vm: DownloadViewModel = new DownloadViewModel();
  navPathStack: NavPathStack = new NavPathStack();
  @Local currentTab: number = 0;
  @Local showAdd: boolean = false;
  @Local addUrl: string = '';
  @Local addName: string = '';

  @Computed
  get p(): Palette {
    return palette(this.vm.theme);
  }

  aboutToAppear(): void {
    this.vm.init();
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
    if (this.currentTab === 1) {
      return this.vm.tasks.filter((t) => t.status === TaskStatus.Completed);
    }
    return this.vm.tasks.filter((t) => t.status !== TaskStatus.Completed);
  }

  build() {
    Navigation(this.navPathStack) {
      this.MasterView()
    }
    .title('FluxDown')
    .backgroundColor(this.vm.theme === 'dark' ? '#15171C' : '#F2F4F8')
    .menus([
      { value: '新建', action: () => { this.showAdd = true; } },
      {
        value: '设置',
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
    } else if (name === 'settings') {
      NavDestination() {
        SettingsContent({ vm: this.vm })
      }
      .title('设置')
    }
  }

  @Builder
  MasterView() {
    Column() {
      Row() {
        this.TabButton('下载中', 0)
        this.TabButton('已完成', 1)
      }
      .width('100%')
      .padding({ top: 8, bottom: 8 })

      if (this.showAdd) {
        this.AddSheet()
      }

      if (this.visibleTasks.length === 0) {
        Column() {
          Text('暂无下载任务').fontColor(this.p.textSecondary).fontSize(16)
          Text('点击右上角“新建”添加下载链接')
            .fontColor(this.p.textSecondary)
            .fontSize(12)
            .margin({ top: 6 })
        }
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List() {
          ForEach(
            this.visibleTasks,
            (task: DownloadTask) => {
              ListItem() {
                this.TaskRow(task)
              }.onClick(() => {
                this.navPathStack.pushPath({ name: 'detail', param: task });
              })
            },
            (task: DownloadTask) => task.id
          )
        }
        .layoutWeight(1)
        .width('100%')
        .divider({ strokeWidth: 1, color: this.p.border })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
  }

  @Builder
  TabButton(label: string, index: number) {
    Button(label)
      .width('50%')
      .backgroundColor(this.currentTab === index ? this.p.primary : this.p.surface)
      .fontColor(this.currentTab === index ? '#FFFFFF' : this.p.text)
      .onClick(() => {
        this.currentTab = index;
      })
  }

  @Builder
  TaskRow(task: DownloadTask) {
    Row() {
      Column() {
        Text(task.fileName)
          .fontSize(15)
          .fontColor(this.p.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Row() {
          Text(statusText(task.status)).fontSize(12).fontColor(this.p.textSecondary)
          if (task.status === TaskStatus.Downloading) {
            Text('  ' + formatSpeed(task.speed)).fontSize(12).fontColor(this.p.primary)
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
            .fontColor('#EF4444')
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
            .onClick(() => {
              this.doExport(task);
            })
        }
        Button('移除')
          .height(32)
          .fontSize(12)
          .backgroundColor('#EF4444')
          .onClick(() => {
            this.vm.remove(task);
          })
      }
      .padding({ left: 8 })
    }
    .padding(12)
    .backgroundColor(this.p.surface)
    .borderRadius(12)
    .margin({ left: 12, right: 12, top: 6, bottom: 6 })
  }

  @Builder
  AddSheet() {
    Column() {
      Text('新建下载').fontSize(16).fontColor(this.p.text).margin({ bottom: 10 })
      TextInput({ placeholder: '下载链接 (http/https/ftp/*.m3u8)', text: this.addUrl })
        .onChange((v: string) => {
          this.addUrl = v;
        })
        .width('100%')
      TextInput({ placeholder: '文件名 (可选)', text: this.addName })
        .onChange((v: string) => {
          this.addName = v;
        })
        .width('100%')
        .margin({ top: 8 })
      Row() {
        Button('取消').onClick(() => {
          this.showAdd = false;
          this.addUrl = '';
          this.addName = '';
        })
        Button('确定')
          .backgroundColor(this.p.primary)
          .onClick(() => {
            this.vm.addDownload(this.addUrl, this.addName || undefined);
            this.showAdd = false;
            this.addUrl = '';
            this.addName = '';
          })
      }
      .justifyContent(FlexAlign.SpaceBetween)
      .width('100%')
      .margin({ top: 12 })
    }
    .padding(16)
    .backgroundColor(this.p.surface)
    .borderRadius(12)
    .margin(12)
  }
}

@ComponentV2
struct TaskDetailContent {
  @Param task: DownloadTask = new DownloadTask();
  @Param vm: DownloadViewModel = new DownloadViewModel();

  @Computed
  get p(): Palette {
    return palette(this.vm.theme);
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
        this.Row2('协议', this.task.protocol)
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
      .width('100%')
      .layoutWeight(1)

      Row() {
        if (this.task.status === TaskStatus.Downloading) {
          Button('暂停').width('30%').onClick(() => this.vm.pause(this.task))
        } else if (this.task.status === TaskStatus.Paused || this.task.status === TaskStatus.Error) {
          Button('继续').width('30%').onClick(() => this.vm.resume(this.task))
        } else if (this.task.status === TaskStatus.Completed) {
          Button('导出到公共 Download')
            .width('30%')
            .onClick(async () => {
              try {
                const path = await this.vm.exportToDownload(this.task);
                promptAction.showToast({ message: '已导出到公共 Download: ' + path });
              } catch (e) {
                promptAction.showToast({ message: '导出失败: ' + ((e as Error)?.message || String(e)) });
              }
            })
        }
        Button('移除')
          .width('30%')
          .backgroundColor('#EF4444')
          .onClick(() => this.vm.remove(this.task))
      }
      .justifyContent(FlexAlign.SpaceAround)
      .width('100%')
      .padding(12)
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

@ComponentV2
struct SettingsContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();

  @Computed
  get p(): Palette {
    return palette(this.vm.theme);
  }

  build() {
    Column() {
      List() {
        ListItem() {
          Row() {
            Text('最大线程数').fontColor(this.p.text).layoutWeight(1)
            Text(String(this.vm.maxSegments)).fontColor(this.p.primary)
          }
          .padding(12)
          .width('100%')
        }
        ListItem() {
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
            .padding(12)
        }
        ListItem() {
          Row() {
            Text('下载完成后校验完整性 (SHA-256)').fontColor(this.p.text).layoutWeight(1)
            Toggle({ isOn: this.vm.verifyIntegrity, type: ToggleType.Switch })
              .onChange((v: boolean) => {
                this.vm.setVerify(v);
              })
          }
          .padding(12)
          .width('100%')
        }
        ListItem() {
          Row() {
            Text('下载完成后自动导出到公共 Download').fontColor(this.p.text).layoutWeight(1)
            Toggle({ isOn: this.vm.autoExport, type: ToggleType.Switch })
              .onChange((v: boolean) => {
                this.vm.setAutoExport(v);
              })
          }
          .padding(12)
          .width('100%')
        }
        ListItem() {
          Row() {
            Text('主题').fontColor(this.p.text).layoutWeight(1)
            Button(this.vm.theme === 'dark' ? '深色' : '浅色').onClick(() => {
              this.vm.setTheme(this.vm.theme === 'dark' ? 'light' : 'dark');
            })
          }
          .padding(12)
          .width('100%')
        }
        ListItem() {
          Row() {
            Text('MCP 本地服务 (127.0.0.1:17800)').fontColor(this.p.text).layoutWeight(1)
            Toggle({ isOn: this.vm.mcpEnabled, type: ToggleType.Switch })
              .onChange((v: boolean) => {
                this.vm.setMcp(v);
              })
          }
          .padding(12)
          .width('100%')
        }
        ListItem() {
          Column() {
            Text('MCP Bearer Token').fontColor(this.p.textSecondary).fontSize(12).alignSelf(ItemAlign.Start)
            TextInput({ text: this.vm.mcpToken })
              .onChange((v: string) => {
                this.vm.mcpToken = v;
              })
              .width('100%')
              .margin({ top: 6 })
          }
          .padding(12)
          .width('100%')
        }
      }
      .width('100%')
      .layoutWeight(1)

      Column() {
        Text('目标 API: HarmonyOS NEXT 24 (Mate 60 Pro · NEXT 6.1.1.120)')
          .fontSize(11)
          .fontColor(this.p.textSecondary)
          .width('100%')
        Text('权限 ohos.permission.INTERNET 等已在 module.json5 中声明')
          .fontSize(11)
          .fontColor(this.p.textSecondary)
          .width('100%')
          .margin({ top: 4 })
        Text('文件默认存于应用沙箱；完成后可在任务详情/列表中“导出到公共 Download”目录（手机无需额外权限）')
          .fontSize(11)
          .fontColor(this.p.textSecondary)
          .width('100%')
          .margin({ top: 4 })
      }
      .padding(12)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
  }
}
