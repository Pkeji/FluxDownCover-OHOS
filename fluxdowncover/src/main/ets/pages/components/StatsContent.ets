import { Palette, palette, iconRes, RADIUS_CARD, MATERIAL_BORDER_WIDTH, materialBorder } from './SharedUI';
import { DownloadViewModel } from '../../viewmodel/DownloadViewModel';
import { formatBytes, formatSpeed } from '../../utils/common';

@ComponentV2
struct StatsContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  @Computed
  get tintColor(): string {
    return this.vm.iconTint === 'mono' ? this.p.text : this.p.primary;
  }

  build() {
    Scroll() {
      Column() {
        Column() {
          Text('下载概览').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.p.text)
            .margin({ bottom: 12 })

          this.StatRow('总任务数', `${this.vm.getStats().totalTasks}`, 'list')
          this.StatRow('下载中', `${this.vm.getStats().activeCount}`, 'download')
          this.StatRow('已完成', `${this.vm.getStats().completedCount}`, 'check')
          this.StatRow('已暂停', `${this.vm.getStats().pausedCount}`, 'pause')
          this.StatRow('错误', `${this.vm.getStats().errorCount}`, 'alert')
          this.StatRow('已下载', formatBytes(this.vm.getStats().totalDownloaded), 'download')
          this.StatRow('总大小', formatBytes(this.vm.getStats().totalSize), 'disk')
          this.StatRow('当前速度', formatSpeed(this.vm.getStats().currentSpeed), 'gauge')
          this.StatRow('平均速度', formatSpeed(this.vm.getStats().avgSpeed), 'gauge')
          this.StatRow('完成率', `${this.vm.getStats().completionRate.toFixed(1)}%`, 'circle_check')
          this.StatRow('预计剩余',
            this.vm.getStats().estimatedTimeRemaining > 0 ?
            `${Math.ceil(this.vm.getStats().estimatedTimeRemaining)}秒` : '未知', 'clock')
        }
        .padding(16)
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, bottom: 16 })

        // Category breakdown
        Column() {
          Text('分类统计').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.p.text)
            .margin({ bottom: 12 })
          ForEach(this.vm.getCategories(), (cat: string) => {
            this.StatRow(cat, `${this.vm.tasks.filter(t => t.category === cat).length} 个`, 'tag')
          })
        }
        .padding(16)
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16 })
      }
      .width('100%')
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .contentEndOffset((AppStorage.get<number>('fluxdown_naviIndicatorHeight') ?? 0) + 52 + 16 + 16)
    .edgeEffect(EdgeEffect.Spring)
  }

  @Builder
  StatRow(label: string, value: string, icon: string) {
    Row() {
      Image(iconRes(icon)).width(16).height(16).fillColor(this.tintColor).margin({ right: 12 })
      Text(label).fontSize(14).fontColor(this.p.textSecondary).layoutWeight(1)
      Text(value).fontSize(14).fontColor(this.p.text)
    }
    .width('100%')
    .padding({ top: 10, bottom: 10 })
  }
}

export default StatsContent;
