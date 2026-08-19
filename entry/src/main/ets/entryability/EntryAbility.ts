import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { DatabaseManager } from '../store/DatabaseManager';
import { DownloadEngine } from '../engine/DownloadEngine';

const DOMAIN: number = 0x0001;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // Initialise storage + engine with the ability context.
    DatabaseManager.getInstance().init(this.context);
    DownloadEngine.getInstance().init(this.context);
    hilog.info(DOMAIN, 'FluxDown', '%{public}s', 'FluxDown onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'FluxDown', '%{public}s', 'FluxDown onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'FluxDown', 'Failed to load pages/Index: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'FluxDown', '%{public}s', 'pages/Index loaded');
    });
  }
}
