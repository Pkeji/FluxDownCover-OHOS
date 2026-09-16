import { liveViewManager } from '@kit.LiveViewKit';
import { wantAgent, WantAgent } from '@kit.AbilityKit';
import { common } from '@kit.AbilityKit';
import { logCollector } from '../utils/LogCollector';

/**
 * 鸿蒙实况窗（类似iOS灵动岛）助手
 * 下载过程中在实况窗显示进度，点击可回到APP
 */
export class LiveViewHelper {
  private static instance: LiveViewHelper | null = null;
  private enabled: boolean = true;
  private liveViewIds: Map<string, number> = new Map();
  private sequences: Map<string, number> = new Map();
  private nextId: number = 1;
  private clickAgent: WantAgent | null = null;

  static getInstance(): LiveViewHelper {
    if (!LiveViewHelper.instance) {
      LiveViewHelper.instance = new LiveViewHelper();
    }
    return LiveViewHelper.instance;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.stopAll();
    }
  }

  /**
   * 初始化点击跳转的WantAgent（点击实况窗回到APP）
   */
  initClickAgent(context: common.UIAbilityContext): void {
    if (this.clickAgent) return;
    try {
      const want = {
        bundleName: context.abilityInfo.bundleName,
        abilityName: context.abilityInfo.name
      };
      wantAgent.getWantAgent(
        {
          wants: [want],
          operationType: wantAgent.OperationType.START_ABILITY,
          requestCode: 0,
          wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
        },
        (err, agent) => {
          if (!err && agent) {
            this.clickAgent = agent;
          }
        }
      );
    } catch (e) {
      logCollector.warn('LiveView', `initClickAgent failed: ${JSON.stringify(e)}`);
    }
  }

  /**
   * 启动或更新下载实况窗
   */
  async updateDownload(context: common.UIAbilityContext, taskId: string, fileName: string, progress: number, speed: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const isEnabled = await liveViewManager.isLiveViewEnabled().catch((e) => {
        logCollector.warn('LiveView', `isLiveViewEnabled failed: ${JSON.stringify(e)}`);
        return false;
      });
      if (!isEnabled) {
        logCollector.warn('LiveView', 'LiveView is not enabled on this device');
        return;
      }
      logCollector.info('LiveView', `LiveView enabled, updating task ${taskId} progress ${progress}`);

      this.initClickAgent(context);

      let lvId = this.liveViewIds.get(taskId);
      const isNew = !lvId;
      if (!lvId) {
        lvId = this.nextId++;
        this.liveViewIds.set(taskId, lvId);
      }

      const percent = Math.min(100, Math.max(0, Math.floor(progress * 100)));

      // sequence 每次更新必须递增
      const seq = (this.sequences.get(taskId) ?? 0) + 1;
      this.sequences.set(taskId, seq);

      // 进度类型场景：PROGRESS，content 为 RichText 数组
      const richTextContent: liveViewManager.RichText[] = [
        { text: `${percent}%  ${speed}` }
      ];

      const primary: liveViewManager.PrimaryData = {
        title: fileName.length > 20 ? fileName.substring(0, 20) + '…' : fileName,
        content: richTextContent,
        layoutData: {
          layoutType: liveViewManager.LayoutType.LAYOUT_TYPE_PROGRESS,
          progress: percent
        } as liveViewManager.ProgressLayout
      };
      if (this.clickAgent) {
        primary.clickAction = this.clickAgent;
      }

      const liveViewData: liveViewManager.LiveViewData = {
        primary: primary
      };

      const liveView: liveViewManager.LiveView = {
        id: lvId,
        event: 'PROGRESS',
        sequence: seq,
        liveViewData: liveViewData
      };

      if (isNew) {
        await liveViewManager.startLiveView(liveView).catch((e) => {
          logCollector.warn('LiveView', `startLiveView failed: ${JSON.stringify(e)}`);
        });
      } else {
        await liveViewManager.updateLiveView(liveView).catch((e) => {
          logCollector.warn('LiveView', `updateLiveView failed: ${JSON.stringify(e)}`);
        });
      }
    } catch (e) {
      logCollector.warn('LiveView', `updateDownload failed: ${JSON.stringify(e)}`);
    }
  }

  /**
   * 停止任务的实况窗
   */
  stop(taskId: string): void {
    const lvId = this.liveViewIds.get(taskId);
    if (lvId) {
      const seq = (this.sequences.get(taskId) ?? 0) + 1;
      this.sequences.set(taskId, seq);
      const richTextContent: liveViewManager.RichText[] = [
        { text: '已完成' }
      ];
      const primary: liveViewManager.PrimaryData = {
        title: '下载完成',
        content: richTextContent
      };
      const liveViewData: liveViewManager.LiveViewData = {
        primary: primary
      };
      const liveView: liveViewManager.LiveView = {
        id: lvId,
        event: 'PROGRESS',
        sequence: seq,
        liveViewData: liveViewData
      };
      liveViewManager.stopLiveView(liveView).catch((e) => {
        logCollector.warn('LiveView', `stopLiveView failed: ${JSON.stringify(e)}`);
      });
      this.liveViewIds.delete(taskId);
      this.sequences.delete(taskId);
    }
  }

  /**
   * 移除任务的实况窗（异步，供完成时调用）
   */
  async removeDownload(taskId: string): Promise<void> {
    this.stop(taskId);
  }

  /**
   * 停止所有实况窗
   */
  stopAll(): void {
    this.liveViewIds.forEach((_, taskId) => this.stop(taskId));
  }
}
