import { Palette, palette, iconRes, RADIUS_CARD, MATERIAL_BORDER_WIDTH, materialBorder, statusText, protocolLabelIcon } from './SharedUI';
import { DownloadViewModel } from '../../viewmodel/DownloadViewModel';
import { DownloadTask, Segment } from '../../model/DownloadTask';
import { TaskStatus } from '../../model/TaskStatus';
import { ProtocolType } from '../../model/ProtocolType';
import { protocolMeta, formatBytes, formatSpeed, formatDateTime, formatDuration } from '../../utils/common';

@ComponentV2
struct TaskDetailContent {
  @Param task: DownloadTask = new DownloadTask();
  @Param vm: DownloadViewModel = new DownloadViewModel();
  @Local renameVisible: boolean = false;
  @Local renameDraft: string = '';
  @Local moveVisible: boolean = false;
  @Local movePathDraft: string = '';

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

      Scroll() {
        Column() {
          Column() {
            this.Row2('状态', statusText(this.task.status))
            this.Row2('协议', protocolMeta(this.task.protocol).label + ' · ' + protocolMeta(this.task.protocol).desc)
            this.Row2('大小', this.task.totalBytes > 0 ? formatBytes(this.task.totalBytes) : '未知')
            this.Row2('已下载', formatBytes(this.task.downloadedBytes))
            this.Row2('进度', this.task.totalBytes > 0 ? this.task.percent + '%' : '-')
            this.Row2('速度', formatSpeed(this.task.status === TaskStatus.Completed ? this.task.peakSpeed : this.task.speed))
            this.Row2('分类', this.task.category || '默认')
            this.Row2('优先级', this.task.priority > 0 ? `高 (${this.task.priority})` :
              this.task.priority < 0 ? `低 (${this.task.priority})` : '普通')
            if (this.task.queueId) {
              this.Row2('所属队列', this.queueNameOf(this.task.queueId))
            }
            this.Row2('线程数', this.task.segmentCount > 0 ? `${this.task.segmentCount} 线程` :
              this.task.segments.length > 0 ? `${this.task.segments.length} 线程 (自动)` : `${this.vm.maxSegments} 线程 (自动)`)
            this.Row2('任务限速', this.task.speedLimit > 0 ? formatSpeed(this.task.speedLimit) : '不限')
            this.Row2('创建时间', formatDateTime(this.task.createdAt))
            if (this.task.finishedAt > 0) {
              this.Row2('完成时间', formatDateTime(this.task.finishedAt))
              this.Row2('下载耗时', formatDuration(this.task.finishedAt - this.task.createdAt))
            }
            if (this.task.sha256) {
              this.Row2('SHA-256', this.task.sha256)
            }
            this.Row2('保存位置', this.task.filePath || this.task.dirPath || '未知')
            this.Row2('校验完整性', this.task.verifyIntegrity ? '开启' : '关闭')
            this.Row2('HTTP 认证', this.task.authHeader ? '已设置' : '无')
            this.Row2('链接', this.task.url)
            if (this.task.status === TaskStatus.Error) {
              this.Row2('错误', this.task.errorMessage)
            }
          }
          .width('100%')
          .backgroundColor(this.p.surface)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(RADIUS_CARD)
          .margin({ left: 12, right: 12, top: 4, bottom: 8 })
          .clip(true)

          // ── BT 做种面板 ──
          if (this.task.protocol === ProtocolType.BITTORRENT) {
            Column() {
              this.Row2('做种状态', this.seedStatusText(this.task.seedingStatus))
              if (this.task.uploadedBytes > 0) {
                this.Row2('已上传', formatBytes(this.task.uploadedBytes))
                this.Row2('分享率', this.task.seedRatio > 0 ? this.task.seedRatio.toFixed(3) : '-')
              }
              if (this.task.seedSeconds > 0) {
                this.Row2('做种时长', formatDuration(this.task.seedSeconds * 1000))
              }
              Row() {
                Button() {
                  Row() {
                    Image(iconRes(this.task.seedingStatus === 'none' ? 'upload' : 'pause'))
                      .width(15).height(15).fillColor(this.p.onPrimary)
                    Text(this.task.seedingStatus === 'none' ? '开始做种' : '停止做种')
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
                  if (this.task.seedingStatus === 'none') {
                    this.vm.startSeeding(this.task);
                  } else {
                    this.vm.stopSeeding(this.task);
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
          if (this.task.segments.length > 0) {
            Column() {
              Row() {
                Text(`分段信息 (${this.task.segments.length})`)
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.p.text)
                Blank()
                Text(`${this.doneSegments()}/${this.task.segments.length} 完成`)
                  .fontSize(12)
                  .fontColor(this.p.textSecondary)
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 12, bottom: 6 })

              // 分段进度可视化格子矩阵
              Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
                ForEach(this.task.segments.slice(0, 120), (seg: Segment) => {
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

              ForEach(this.task.segments.slice(0, 50), (seg: Segment, idx: number) => {
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
              if (this.task.segments.length > 50) {
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
              if (this.task.status === TaskStatus.Downloading || this.task.status === TaskStatus.Queued) {
                Button() {
                  Row() {
                    Image(iconRes('pause')).width(14).height(14).fillColor('#FFFFFF')
                    Text('暂停').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                .backgroundColor('#B06100').borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                .onClick(() => { this.vm.pause(this.task); })
              } else if (this.task.status === TaskStatus.Paused || this.task.status === TaskStatus.Error) {
                Button() {
                  Row() {
                    Image(iconRes('play')).width(14).height(14).fillColor('#FFFFFF')
                    Text('继续下载').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                .backgroundColor(this.p.primarySolid).borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                .onClick(() => { this.vm.resume(this.task); })
              }

              if (this.task.status !== TaskStatus.Completed) {
                Button() {
                  Row() {
                    Image(iconRes('recheck')).width(14).height(14).fillColor('#FFFFFF')
                    Text('校验').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                .backgroundColor('#4B5563').borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                .onClick(() => { this.vm.recheck(this.task); })
              }

              Button() {
                Row() {
                  Image(iconRes('copy')).width(14).height(14).fillColor(this.p.text)
                  Text('复制链接').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                }
                .justifyContent(FlexAlign.Center)
              }
              .backgroundColor(this.p.surfaceHighlight).borderRadius(8).height(36).layoutWeight(1)
              .border({ width: 1, color: this.p.border })
              .onClick(() => {
                this.vm.copyToClipboard(this.task.url);
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
              .backgroundColor(this.p.surfaceHighlight).borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
              .border({ width: 1, color: this.p.border })
              .onClick(() => {
                this.renameDraft = this.task.fileName;
                this.renameVisible = true;
              })

              if (this.task.status === TaskStatus.Completed) {
                Button() {
                  Row() {
                    Image(iconRes('folder')).width(14).height(14).fillColor(this.p.text)
                    Text('打开目录').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                .backgroundColor(this.p.surfaceHighlight).borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                .border({ width: 1, color: this.p.border })
                .onClick(() => { this.vm.openFileLocation(this.task); })
              }

              Button() {
                Row() {
                  Image(iconRes('move')).width(14).height(14).fillColor(this.p.text)
                  Text('移动').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                }
                .justifyContent(FlexAlign.Center)
              }
              .backgroundColor(this.p.surfaceHighlight).borderRadius(8).height(36).layoutWeight(1)
              .border({ width: 1, color: this.p.border })
              .onClick(() => {
                this.movePathDraft = this.task.filePath || this.task.dirPath || '';
                this.moveVisible = true;
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
              .backgroundColor(this.p.errorSolid).borderRadius(8).height(36).layoutWeight(1)
              .onClick(() => { this.vm.remove(this.task); })
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
        .padding({ bottom: 60 })
      }
      .edgeEffect(EdgeEffect.Spring)
      .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
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
    return this.task.segments.filter(s => s.done).length;
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
