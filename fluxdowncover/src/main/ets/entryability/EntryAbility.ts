import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';
import { DatabaseManager } from '../store/DatabaseManager';
import { DownloadEngine } from '../engine/DownloadEngine';
import { SettingsStore } from '../store/SettingsStore';
import { McpServer } from '../mcp/McpServer';
import { BackgroundTaskManager } from '../util/BackgroundTaskManager';

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

  // Path 3: direct download protocol links (viewData action)
  if (want.action === 'ohos.want.action.viewData' && want.uri) {
    const uri = want.uri;
    // HTTP/HTTPS/FTP/SFTP 直链
    if (uri.startsWith('http://') || uri.startsWith('https://') ||
        uri.startsWith('ftp://') || uri.startsWith('sftp://')) {
      return uri;
    }
    // 迅雷/快车/旋风专用链接
    if (uri.startsWith('thunder://') || uri.startsWith('flashget://') || uri.startsWith('qqdl://')) {
      return uri;
    }
    // 磁力链接
    if (uri.startsWith('magnet:')) {
      return uri;
    }
    // eD2K 链接
    if (uri.startsWith('ed2k://')) {
      return uri;
    }
  }

  return '';
}

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // Initialise all stores and engine with the ability context.
    DatabaseManager.getInstance().init(this.context);
    DownloadEngine.getInstance().init(this.context);
    SettingsStore.getInstance().init(this.context).catch((e: Error) => {
      hilog.error(DOMAIN, 'FluxDownCover', 'SettingsStore init failed: %{public}s', e.message);
    });
    BackgroundTaskManager.getInstance().init(this.context);

    // Handle deep link from cold start
    const url = extractUrlFromWant(want);
    if (url) {
      AppStorage.setOrCreate<string>('pendingDownloadUrl', url);
      hilog.info(DOMAIN, 'FluxDownCover', 'Deep link (cold start): %{public}s', url);
    }

    hilog.info(DOMAIN, 'FluxDownCover', '%{public}s', 'FluxDownCover onCreate');
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // Handle deep link when app is already running (warm start)
    const url = extractUrlFromWant(want);
    if (url) {
      // Update AppStorage so the UI observer triggers
      AppStorage.setOrCreate<string>('pendingDownloadUrl', url);
      hilog.info(DOMAIN, 'FluxDownCover', 'Deep link (warm start): %{public}s', url);
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'FluxDownCover', '%{public}s', 'FluxDownCover onDestroy');
    BackgroundTaskManager.getInstance().stop();
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 仅 PC（2in1）设备设置沉浸式全屏布局，不影响手机端
    if (deviceInfo.deviceType === '2in1') {
      const mainWindow = windowStage.getMainWindowSync();
      mainWindow.setWindowLayoutFullScreen(true).catch((e: Error) => {
        hilog.error(DOMAIN, 'FluxDownCover', 'setWindowLayoutFullScreen failed: %{public}s', e.message);
      });
    }

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'FluxDownCover', 'Failed to load pages/Index: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'FluxDownCover', '%{public}s', 'pages/Index loaded');
    });
  }
}
