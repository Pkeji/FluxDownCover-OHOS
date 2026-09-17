import { Palette, palette, iconRes, RADIUS_CARD, MATERIAL_BORDER_WIDTH, materialBorder, statusText, protocolLabelIcon } from './SharedUI';
import { DownloadViewModel } from '../../viewmodel/DownloadViewModel';
import { DownloadTask, Segment } from '../../model/DownloadTask';
import { TaskStatus } from '../../model/TaskStatus';
import { ProtocolType } from '../../model/ProtocolType';
import { protocolMeta, formatBytes, formatSpeed, formatDateTime, formatDuration } from '../../utils/common';
import { promptAction } from '@kit.ArkUI';
import { picker } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

@ComponentV2
struct TaskDetailContent {
  @Param task: DownloadTask = new DownloadTask();
  @Param vm: DownloadViewModel = new DownloadViewModel();
  @Local renameVisible: boolean = false;
  @Local renameDraft: string = '';
  @Local moveVisible: boolean = false;
  @Local movePathDraft: string = '';
  @Local showRenameInput: boolean = false;
  @Local showMoveInput: boolean = false;
  @Local showDeleteConfirm: boolean = false;

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  @Computed
  get liveTask(): DownloadTask {
    return this.vm.getTask(this.task.id) ?? this.task;
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
    Column() {
      Row() {
        Text(this.liveTask.fileName).fontSize(18).fontColor(this.p.text).fontWeight(FontWeight.Medium)
      }
      .width('100%')
      .padding(12)

      Scroll() {
        Column() {
          Column() {
            this.Row2('状态', statusText(this.liveTask.status))
            this.Row2('协议', protocolMeta(this.liveTask.protocol).label + ' · ' + protocolMeta(this.liveTask.protocol).desc)
            this.Row2('大小', this.liveTask.totalBytes > 0 ? formatBytes(this.liveTask.totalBytes) : '未知')
            this.Row2('已下载', formatBytes(this.liveTask.downloadedBytes))
            this.Row2('进度', this.liveTask.totalBytes > 0 ? this.liveTask.percent + '%' : '-')
            this.Row2('速度', formatSpeed(this.liveTask.status === TaskStatus.Completed ? this.liveTask.peakSpeed : this.liveTask.speed))
            this.Row2('分类', this.liveTask.category || '默认')
            this.Row2('优先级', this.liveTask.priority > 0 ? `高 (${this.liveTask.priority})` :
              this.liveTask.priority < 0 ? `低 (${this.liveTask.priority})` : '普通')
            if (this.liveTask.queueId) {
              this.Row2('所属队列', this.queueNameOf(this.liveTask.queueId))
            }
            this.Row2('线程数', this.liveTask.segmentCount > 0 ? `${this.liveTask.segmentCount} 线程` :
              this.liveTask.segments.length > 0 ? `${this.liveTask.segments.length} 线程 (自动)` : `${this.vm.maxSegments} 线程 (自动)`)
            this.Row2('任务限速', this.liveTask.speedLimit > 0 ? formatSpeed(this.liveTask.speedLimit) : '不限')
            this.Row2('创建时间', formatDateTime(this.liveTask.createdAt))
            if (this.liveTask.finishedAt > 0) {
              this.Row2('完成时间', formatDateTime(this.liveTask.finishedAt))
              this.Row2('下载耗时', formatDuration(this.liveTask.finishedAt - this.liveTask.createdAt))
            }
            if (this.liveTask.sha256) {
              this.Row2('SHA-256', this.liveTask.sha256)
            }
            this.Row2('保存位置', this.liveTask.filePath || this.liveTask.dirPath || '未知')
            this.Row2('校验完整性', this.liveTask.verifyIntegrity ? '开启' : '关闭')
            this.Row2('HTTP 认证', this.liveTask.authHeader ? '已设置' : '无')
            this.Row2('链接', this.liveTask.url)
            if (this.liveTask.status === TaskStatus.Error) {
              this.Row2('错误', this.liveTask.errorMessage)
            }
          }
          .width('100%')
          .backgroundColor(this.p.surface)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(RADIUS_CARD)
          .margin({ left: 12, right: 12, top: 4, bottom: 8 })
          .clip(true)

          // ── BT 做种面板 ──
          if (this.liveTask.protocol === ProtocolType.BITTORRENT) {
            Column() {
              this.Row2('做种状态', this.seedStatusText(this.liveTask.seedingStatus))
              if (this.liveTask.uploadedBytes > 0) {
                this.Row2('已上传', formatBytes(this.liveTask.uploadedBytes))
                this.Row2('分享率', this.liveTask.seedRatio > 0 ? this.liveTask.seedRatio.toFixed(3) : '-')
              }
              if (this.liveTask.seedSeconds > 0) {
                this.Row2('做种时长', formatDuration(this.liveTask.seedSeconds * 1000))
              }
              Row() {
                Button() {
                  Row() {
                    Image(iconRes(this.liveTask.seedingStatus === 'none' ? 'upload' : 'pause'))
                      .width(15).height(15).fillColor(this.p.onPrimary)
                    Text(this.liveTask.seedingStatus === 'none' ? '开始做种' : '停止做种')
                      .fontSize(13).fontColor(this.p.onPrimary).margin({ left: 5 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                .backgroundColor(this.p.primarySolid)
                .borderRadius(8)
                .height(36)
                .layoutWeight(1)
                .margin({ right: 6 })
                .onClick(() => {
                  if (this.liveTask.seedingStatus === 'none') {
                    this.vm.startSeeding(this.liveTask);
                  } else {
                    this.vm.stopSeeding(this.liveTask);
                  }
                })
              }
              .width('100%')
              .padding({ left: 12, right: 12, bottom: 12 })
            }
            .width('100%')
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(RADIUS_CARD)
            .margin({ left: 12, right: 12, bottom: 8 })
            .clip(true)
          }

          // ── 分段信息 ──
          if (this.liveTask.segments.length > 0) {
            Column() {
              Row() {
                Text(`分段信息 (${this.liveTask.segments.length})`)
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.p.text)
                Blank()
                Text(`${this.doneSegments()}/${this.liveTask.segments.length} 完成`)
                  .fontSize(12)
                  .fontColor(this.p.textSecondary)
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 12, bottom: 6 })

              // 分段进度可视化格子矩阵
              Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
                ForEach(this.liveTask.segments.slice(0, 120), (seg: Segment) => {
                  Stack()
                    .width(10).height(10)
                    .borderRadius(2)
                    .margin(1.5)
                    .backgroundColor(
                      seg.done ? this.p.success :
                        seg.downloaded > 0 ? this.p.primary :
                          this.p.surfaceHighlight
                    )
                }, (seg: Segment) => seg.index.toString())
              }
              .width('100%')
              .padding({ left: 12, right: 12, bottom: 8 })

              ForEach(this.liveTask.segments.slice(0, 50), (seg: Segment, idx: number) => {
                Row() {
                  Text(`#${seg.index}`).fontSize(11).fontColor(this.p.textSecondary).width(36)
                  Text((seg.url || '').length > 44 ? (seg.url || '').substring(0, 41) + '...' : (seg.url || ''))
                    .fontSize(11)
                    .fontColor(this.p.text)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .layoutWeight(1)
                  if (seg.done) {
                    Image(iconRes('check')).width(13).height(13).fillColor(this.p.success).width(64)
                  } else {
                    Text(`${formatBytes(seg.downloaded)}`)
                      .fontSize(11)
                      .fontColor(this.p.textSecondary)
                      .width(64)
                      .textAlign(TextAlign.End)
                  }
                }
                .width('100%')
                .padding({ left: 12, right: 12, top: 4, bottom: 4 })
              }, (seg: Segment) => seg.index.toString())
              if (this.liveTask.segments.length > 50) {
                Text(`… 仅显示前 50 个分片`)
                  .fontSize(11)
                  .fontColor(this.p.textSecondary)
                  .padding({ left: 12, right: 12, bottom: 10 })
                  .width('100%')
              }
            }
            .width('100%')
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(RADIUS_CARD)
            .margin({ left: 12, right: 12, bottom: 8 })
            .clip(true)
          }

          // ── 任务操作 ──
          Column() {
            Row() {
              if (this.liveTask.status === TaskStatus.Downloading || this.liveTask.status === TaskStatus.Queued) {
                Button() {
                  Row() {
                    Image(iconRes('pause')).width(14).height(14).fillColor('#FFFFFF')
                    Text('暂停').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                .type(ButtonType.Capsule).backgroundColor('#B06100').height(36).layoutWeight(1).margin({ right: 6 })
                .onClick(() => { this.vm.pause(this.liveTask); })
              } else if (this.liveTask.status === TaskStatus.Paused || this.liveTask.status === TaskStatus.Error) {
                Button() {
                  Row() {
                    Image(iconRes('play')).width(14).height(14).fillColor('#FFFFFF')
                    Text('继续下载').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                .type(ButtonType.Capsule).backgroundColor(this.p.primarySolid).height(36).layoutWeight(1).margin({ right: 6 })
                .onClick(() => { this.vm.resume(this.liveTask); })
              }

              Button() {
                Row() {
                  Image(iconRes('copy')).width(14).height(14).fillColor(this.p.text)
                  Text('复制链接').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                }
                .justifyContent(FlexAlign.Center)
              }
              .type(ButtonType.Capsule).backgroundColor(this.p.surfaceHighlight).height(36).layoutWeight(1)
              .border({ width: 1, color: this.p.border })
              .onClick(() => {
                this.vm.copyToClipboard(this.liveTask.url);
                promptAction.showToast({ message: '链接已复制' });
              })
            }
            .width('100%')
            .padding({ left: 12, right: 12, top: 8, bottom: 8 })

            Row() {
              Button() {
                Row() {
                  Image(iconRes('rename')).width(14).height(14).fillColor(this.p.text)
                  Text('重命名').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                }
                .justifyContent(FlexAlign.Center)
              }
              .type(ButtonType.Capsule).backgroundColor(this.p.surfaceHighlight).height(36).layoutWeight(1).margin({ right: 6 })
              .border({ width: 1, color: this.p.border })
              .onClick(() => {
                this.renameDraft = this.liveTask.fileName;
                this.showRenameInput = true;
                this.showMoveInput = false;
              })

              if (this.liveTask.status === TaskStatus.Completed) {
                Button() {
                  Row() {
                    Image(iconRes('folder')).width(14).height(14).fillColor(this.p.text)
                    Text('打开目录').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                .type(ButtonType.Capsule).backgroundColor(this.p.surfaceHighlight).height(36).layoutWeight(1).margin({ right: 6 })
                .border({ width: 1, color: this.p.border })
                .onClick(() => {
                  if (!this.liveTask.publicPath) {
                    promptAction.showToast({ message: '文件路径未知' });
                    return;
                  }
                  this.vm.openFileLocation(this.liveTask);
                })
              }

              Button() {
                Row() {
                  Image(iconRes('move')).width(14).height(14).fillColor(this.p.text)
                  Text('移动').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                }
                .justifyContent(FlexAlign.Center)
              }
              .type(ButtonType.Capsule).backgroundColor(this.p.surfaceHighlight).height(36).layoutWeight(1)
              .border({ width: 1, color: this.p.border })
              .onClick(async () => {
                try {
                  const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
                  const documentPicker = new picker.DocumentViewPicker(ctx);
                  const saveOptions = new picker.DocumentSaveOptions();
                  saveOptions.newFileNames = [this.liveTask.fileName];
                  const uris = await documentPicker.save(saveOptions);
                  if (!uris || uris.length === 0) return;
                  const uri = uris[0];
                  // 从 file uri 提取目录路径
                  // uri 形如 file://docs/storage/Users/currentUser/Download/xxx
                  const idx = uri.lastIndexOf('/');
                  const dirUri = uri.substring(0, idx);
                  // 转换为可写路径
                  const dirPath = dirUri.replace('file://docs/storage/Users/currentUser/', '/storage/users/currentUser/');
                  await this.vm.moveTask(this.liveTask, dirPath);
                  promptAction.showToast({ message: '移动成功' });
                } catch (e) {
                  promptAction.showToast({ message: '移动失败: ' + ((e as Error)?.message || String(e)) });
                }
              })
            }
            .width('100%')
            .padding({ left: 12, right: 12, top: 4, bottom: 8 })

            Row() {
              Button() {
                Row() {
                  Image(iconRes('trash')).width(14).height(14).fillColor('#FFFFFF')
                  Text('删除').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                }
                .justifyContent(FlexAlign.Center)
              }
              .type(ButtonType.Capsule).backgroundColor('#E8504F').height(36).layoutWeight(1)
              .onClick(() => {
                this.showDeleteConfirm = true;
              })
            }
            .width('100%')
            .padding({ left: 12, right: 12, bottom: 12 })
          }
          .width('100%')
          .backgroundColor(this.p.surface)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(RADIUS_CARD)
          .margin({ left: 12, right: 12, bottom: 8 })
          .clip(true)
        }
        .width('100%')
        .padding({ bottom: 120 })
      }
      .edgeEffect(EdgeEffect.Spring)
      .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)

    // 重命名居中弹窗
    if (this.showRenameInput) {
      Column()
        .width('100%').height('100%')
        .backgroundColor('rgba(0,0,0,0.4)')
        .onClick(() => { this.showRenameInput = false; })
      Column() {
        Text('重命名').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.p.text).width('100%')
        TextInput({ text: this.renameDraft })
          .fontSize(14).fontColor(this.p.text)
          .borderRadius(8).backgroundColor(this.p.surfaceHighlight).height(44)
          .margin({ top: 16, bottom: 16 })
          .onChange((v) => { this.renameDraft = v; })
        Row() {
          Button('取消').fontSize(14).fontColor(this.p.text)
            .type(ButtonType.Capsule).backgroundColor(this.p.surfaceHighlight).borderRadius(20).height(40).layoutWeight(1).margin({ right: 8 })
            .onClick(() => { this.showRenameInput = false; })
          Button('确定').fontSize(14).fontColor(this.p.onPrimary)
            .type(ButtonType.Capsule).backgroundColor(this.p.primarySolid).borderRadius(20).height(40).layoutWeight(1)
            .onClick(() => {
              if (this.renameDraft) {
                this.vm.renameTask(this.liveTask, this.renameDraft).then(() => {
                  promptAction.showToast({ message: '重命名成功' });
                }).catch(() => {
                  promptAction.showToast({ message: '重命名失败' });
                });
              }
              this.showRenameInput = false;
            })
        }.width('100%')
      }
      .width('80%').padding(20)
      .backgroundColor(this.p.surface)
      .borderRadius(16)
      .onClick(() => {})
    }
    // 删除确认弹窗
    if (this.showDeleteConfirm) {
      Column()
        .width('100%').height('100%')
        .backgroundColor('rgba(0,0,0,0.4)')
        .onClick(() => { this.showDeleteConfirm = false; })
      Column() {
        Text('删除任务').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.p.text).width('100%')
        Text(`确定删除「${this.liveTask.fileName}」吗？`).fontSize(14).fontColor(this.p.textSecondary)
          .width('100%').margin({ top: 12, bottom: 20 })
        Row() {
          Button('取消').fontSize(14).fontColor(this.p.text)
            .type(ButtonType.Capsule).backgroundColor(this.p.surfaceHighlight).borderRadius(20).height(40).layoutWeight(1).margin({ right: 8 })
            .onClick(() => { this.showDeleteConfirm = false; })
          Button('删除').fontSize(14).fontColor('#FFFFFF')
            .type(ButtonType.Capsule).backgroundColor('#E8504F').borderRadius(20).height(40).layoutWeight(1)
            .onClick(() => {
              this.vm.remove(this.liveTask);
              promptAction.showToast({ message: '已删除' });
              this.showDeleteConfirm = false;
            })
        }.width('100%')
      }
      .width('80%').padding(20)
      .backgroundColor(this.p.surface)
      .borderRadius(16)
      .onClick(() => {})
    }
    }
  }

  @Builder
  Row2(label: string, value: string) {
    Row() {
      Text(label).fontSize(13).fontColor(this.p.textSecondary).width(80)
      Text(value).fontSize(13).fontColor(this.p.text).layoutWeight(1).textAlign(TextAlign.End)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .border({ width: { bottom: 0.5 }, color: this.p.border })
  }

  doneSegments(): number {
    return this.liveTask.segments.filter(s => s.done).length;
  }

  queueNameOf(queueId: string): string {
    const q = this.vm.queues.find(q => q.id === queueId);
    return q ? q.name : queueId;
  }

  seedStatusText(status: string): string {
    switch (status) {
      case 'active': return '做种中';
      case 'completed': return '已完成';
      case 'none': return '未做种';
      default: return status;
    }
  }
}

export default TaskDetailContent;
