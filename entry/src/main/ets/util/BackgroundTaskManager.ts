import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0002;
const TAG: string = 'BackgroundTaskManager';

/**
 * Manages the continuous background task (长时任务) so that downloads
 * keep running when the app is moved to the background.
 *
 * Uses BackgroundMode.DATA_TRANSFER which is designed for file downloads.
 * The system shows a persistent notification while the task is active;
 * tapping it brings the user back to the app.
 */
export class BackgroundTaskManager {
  private static instance: BackgroundTaskManager;
  private context: common.UIAbilityContext | null = null;
  private running: boolean = false;

  private constructor() {}

  static getInstance(): BackgroundTaskManager {
    if (!BackgroundTaskManager.instance) {
      BackgroundTaskManager.instance = new BackgroundTaskManager();
    }
    return BackgroundTaskManager.instance;
  }

  /**
   * Store the UIAbility context so we can start/stop the background task later.
   * Called once from EntryAbility.onWindowStageCreate().
   */
  init(context: common.UIAbilityContext): void {
    this.context = context;
  }

  /**
   * Start the continuous background task.
   * Safe to call multiple times – only starts if not already running.
   */
  async start(): Promise<void> {
    if (this.running || !this.context) {
      return;
    }

    try {
      const wantAgentInfo: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: this.context.abilityInfo.bundleName,
            abilityName: 'EntryAbility'
          }
        ],
        operationType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      };

      const agent: WantAgent = await wantAgent.getWantAgent(wantAgentInfo);
      await backgroundTaskManager.startBackgroundRunning(
        this.context,
        backgroundTaskManager.BackgroundMode.DATA_TRANSFER,
        agent
      );
      this.running = true;
      hilog.info(DOMAIN, TAG, 'Background task started (DATA_TRANSFER)');
    } catch (e) {
      hilog.error(DOMAIN, TAG, `Failed to start background task: ${JSON.stringify(e)}`);
    }
  }

  /**
   * Stop the continuous background task.
   * Safe to call multiple times – only stops if currently running.
   */
  async stop(): Promise<void> {
    if (!this.running || !this.context) {
      return;
    }

    try {
      await backgroundTaskManager.stopBackgroundRunning(this.context);
      this.running = false;
      hilog.info(DOMAIN, TAG, 'Background task stopped');
    } catch (e) {
      hilog.error(DOMAIN, TAG, `Failed to stop background task: ${JSON.stringify(e)}`);
    }
  }

  /**
   * Automatically start or stop the background task based on whether
   * there are any active downloads.
   *
   * @param activeCount  number of tasks currently downloading
   */
  async update(activeCount: number): Promise<void> {
    if (activeCount > 0) {
      await this.start();
    } else {
      await this.stop();
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
