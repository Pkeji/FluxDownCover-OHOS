import { notificationManager } from '@kit.NotificationKit';
import { wantAgent, WantAgent } from '@kit.AbilityKit';
import { common } from '@kit.AbilityKit';
import { logCollector } from '../utils/LogCollector';

/**
 * Local notification helper for download progress and completion events.
 * Uses the HarmonyOS notificationManager API; all failures are logged and
 * swallowed (notifications are best-effort — the user can disable them in
 * settings, mirroring FluxDown's "完成通知" toggle).
 */
export class NotificationHelper {
  private static instance: NotificationHelper | null = null;
  private enabled: boolean = true;
  // 每个任务的进度通知ID映射，确保同一个任务更新同一个通知
  private progressNotifyIds: Map<string, number> = new Map();
  private nextId: number = 1000;
  private clickAgent: WantAgent | null = null;

  static getInstance(): NotificationHelper {
    if (!NotificationHelper.instance) {
      NotificationHelper.instance = new NotificationHelper();
    }
    return NotificationHelper.instance;
  }

  /**
   * 初始化点击跳转的WantAgent（点击通知回到APP）
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
            logCollector.info('Notification', 'Click WantAgent initialized');
          } else {
            logCollector.warn('Notification', `Click WantAgent init failed: ${JSON.stringify(err)}`);
          }
        }
      );
    } catch (e) {
      logCollector.warn('Notification', `initClickAgent failed: ${JSON.stringify(e)}`);
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      // 关闭通知时取消所有进度通知
      this.progressNotifyIds.forEach((id) => {
        notificationManager.cancel(id).catch(() => {});
      });
      this.progressNotifyIds.clear();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 发布或更新下载进度通知（通知栏显示进度条）
   */
  async notifyDownloadProgress(context: common.UIAbilityContext, taskId: string, fileName: string, progress: number, speed: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      this.initClickAgent(context);
      let notifyId = this.progressNotifyIds.get(taskId);
      if (!notifyId) {
        notifyId = this.nextId++;
        this.progressNotifyIds.set(taskId, notifyId);
      }
      const slotType = notificationManager.SlotType.SOCIAL_COMMUNICATION;
      await notificationManager.addSlot(slotType).catch(() => {});
      const percent = Math.min(100, Math.max(0, Math.floor(progress * 100)));
      const request: notificationManager.NotificationRequest = {
        id: notifyId,
        // 进度通知使用静默类型，不发声不震动，避免频繁打扰
        notificationSlotType: notificationManager.SlotType.OTHER_TYPES,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: `正在下载: ${fileName}`,
            text: `${percent}%  ${speed}`
          }
        },
        // 进度通知不发声不震动，避免频繁打扰
        isOngoing: true
      };
      // 点击进度通知回到APP
      if (this.clickAgent) {
        request.wantAgent = this.clickAgent;
      }
      await notificationManager.publish(request);
    } catch (e) {
      logCollector.warn('Warn', `FluxDown Cover progress notification failed: ${JSON.stringify(e)}`);
    }
  }

  /**
   * 下载完成通知（发出声音，点击回到APP）
   */
  async notifyDownloadComplete(context: common.UIAbilityContext, taskId: string, fileName: string): Promise<void> {
    // 先取消进度通知
    const progressId = this.progressNotifyIds.get(taskId);
    if (progressId) {
      notificationManager.cancel(progressId).catch(() => {});
      this.progressNotifyIds.delete(taskId);
    }
    if (!this.enabled) {
      return;
    }
    try {
      this.initClickAgent(context);
      const slotType = notificationManager.SlotType.SOCIAL_COMMUNICATION;
      await notificationManager.addSlot(slotType).catch(() => {});
      const request: notificationManager.NotificationRequest = {
        id: Math.floor(Date.now() % 100000),
        notificationSlotType: slotType,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: '下载完成',
            text: `${fileName} 已下载完成`
          }
        }
        // SOCIAL_COMMUNICATION类型默认有声音和震动
      };
      // 点击完成通知回到APP
      if (this.clickAgent) {
        request.wantAgent = this.clickAgent;
      }
      await notificationManager.publish(request);
    } catch (e) {
      logCollector.warn('Warn', `FluxDown Cover notification failed: ${JSON.stringify(e)}`);
    }
  }

  /**
   * 取消任务的进度通知（任务被删除/暂停时调用）
   */
  cancelProgress(taskId: string): void {
    const progressId = this.progressNotifyIds.get(taskId);
    if (progressId) {
      notificationManager.cancel(progressId).catch(() => {});
      this.progressNotifyIds.delete(taskId);
    }
  }
}
