import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';
import { DatabaseManager } from '../store/DatabaseManager';
import { DownloadEngine } from '../engine/DownloadEngine';

const DOMAIN: number = 0x0001;

/**
 * Extract a download URL from a deep-link Want.
 *
 * Supports two entry paths:
 *  1. Custom scheme:  fluxdown://download?url=<encodeURIComponent>
 *  2. System share:   action = ohos.want.action.sendData, text in want.parameters
 *
 * Returns the raw download URL string, or '' if the Want doesn't contain one.
 */
function extractUrlFromWant(want: Want): string {
  if (!want) {
    return '';
  }

  // Path 1: custom URI scheme  fluxdown://download?url=xxx
  if (want.uri && want.uri.startsWith('fluxdown://')) {
    const uri = want.uri;
    const qIdx = uri.indexOf('?');
    if (qIdx < 0) {
      return '';
    }
    const params = uri.substring(qIdx + 1);
    const pairs = params.split('&');
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        continue;
      }
      const key = pair.substring(0, eq);
      const val = pair.substring(eq + 1);
      if (key === 'url') {
        return decodeURIComponent(val);
      }
    }
    return '';
  }

  // Path 2: system share — text/plain content
  if (want.action === 'ohos.want.action.sendData') {
    // Shared text may arrive in want.parameters['content'] or as a plain string
    const params = want.parameters as Record<string, Object> | undefined;
    if (params) {
      const content = params['content'];
      if (typeof content === 'string' && content.trim().length > 0) {
        return content.trim();
      }
      // Some share paths use 'ohos.extra.param.text'
      const text = params['ohos.extra.param.text'];
      if (typeof text === 'string' && text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  return '';
}

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // Initialise storage + engine with the ability context.
    DatabaseManager.getInstance().init(this.context);
    DownloadEngine.getInstance().init(this.context);

    // Handle deep link from cold start
    const url = extractUrlFromWant(want);
    if (url) {
      AppStorage.setOrCreate<string>('pendingDownloadUrl', url);
      hilog.info(DOMAIN, 'FluxDown', 'Deep link (cold start): %{public}s', url);
    }

    hilog.info(DOMAIN, 'FluxDown', '%{public}s', 'FluxDown onCreate');
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // Handle deep link when app is already running (warm start)
    const url = extractUrlFromWant(want);
    if (url) {
      // Update AppStorage so the UI observer triggers
      AppStorage.setOrCreate<string>('pendingDownloadUrl', url);
      hilog.info(DOMAIN, 'FluxDown', 'Deep link (warm start): %{public}s', url);
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'FluxDown', '%{public}s', 'FluxDown onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 仅 PC（2in1）设备设置沉浸式全屏布局，不影响手机端
    if (deviceInfo.deviceType === '2in1') {
      const mainWindow = windowStage.getMainWindowSync();
      mainWindow.setWindowLayoutFullScreen(true).catch((e: Error) => {
        hilog.error(DOMAIN, 'FluxDown', 'setWindowLayoutFullScreen failed: %{public}s', e.message);
      });
    }

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'FluxDown', 'Failed to load pages/Index: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'FluxDown', '%{public}s', 'pages/Index loaded');
    });
  }
}
