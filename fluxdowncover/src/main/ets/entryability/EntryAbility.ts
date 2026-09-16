import { AbilityConstant, UIAbility, Want, Configuration, ConfigurationConstant } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { notificationManager } from '@kit.NotificationKit';
import dataPreferences from '@ohos.data.preferences';
import { DatabaseManager } from '../store/DatabaseManager';
import { DownloadEngine } from '../engine/DownloadEngine';
import { SettingsStore } from '../store/SettingsStore';
import { McpServer } from '../mcp/McpServer';
import { BackgroundTaskManager } from '../utils/BackgroundTaskManager';

const DOMAIN: number = 0x0001;
const STATUS_BAR_HEIGHT_KEY = 'fluxdown_statusBarHeight';
const NAVI_INDICATOR_HEIGHT_KEY = 'fluxdown_naviIndicatorHeight';
const TRANSPARENT_SYSTEM_BAR = '#00000000';

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
  private mainWindow: window.Window | null = null;
  private hasSafeAreaListener: boolean = false;
  private hasAppThemeListener: boolean = false;
  private lastAppTheme: string = '';
  private servicesStarted: boolean = false;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 仅做纯本地初始化（本地数据库/设置/后台任务管理），不联网、不申请权限
    DatabaseManager.getInstance().init(this.context);
    SettingsStore.getInstance().init(this.context).catch((e: Error) => {
      hilog.error(DOMAIN, 'FluxDownCover', 'SettingsStore init failed: %{public}s', e.message);
    });
    BackgroundTaskManager.getInstance().init(this.context);

    // 合规：用户在首启隐私弹窗点“同意”后，通过 eventHub 触发联网服务与权限申请
    this.context.eventHub.on('privacyAgreed', () => {
      this.startAfterPrivacyConsent();
    });

    // 冷启动时若此前已同意隐私政策，则直接启动联网服务与权限申请
    dataPreferences.getPreferences(this.context, 'fluxdown_settings').then((prefs) => {
      prefs.get('privacyAgreed', false).then((v) => {
        if (v === true) {
          this.startAfterPrivacyConsent();
        }
      }).catch(() => {});
      // 同步预读图标着色和主题色设置，写入 AppStorage，避免首帧闪默认色
      try {
        const iconTint = prefs.getSync('iconTint', 'accent') as string;
        AppStorage.setOrCreate<string>('fluxdown_icon_tint', iconTint);
        const colorScheme = prefs.getSync('colorScheme', 'cyan') as string;
        AppStorage.setOrCreate<string>('fluxdown_color_scheme', colorScheme);
      } catch (e) {}
    }).catch(() => {});

    // Handle deep link from cold start
    const url = extractUrlFromWant(want);
    if (url) {
      AppStorage.setOrCreate<string>('pendingDownloadUrl', url);
      hilog.info(DOMAIN, 'FluxDownCover', 'Deep link (cold start): %{public}s', url);
    }

    hilog.info(DOMAIN, 'FluxDownCover', '%{public}s', 'FluxDownCover onCreate');
  }

  /** 隐私政策同意后才执行：启动下载/BT 联网引擎、请求通知权限、初始化账号服务（幂等） */
  private startAfterPrivacyConsent(): void {
    if (this.servicesStarted) {
      return;
    }
    this.servicesStarted = true;
    // 下载引擎（含 BitTorrent DHT/PeerServer/UPnP 联网）
    DownloadEngine.getInstance().init(this.context);

    // 请求通知权限（下载进度/完成通知需要）
    notificationManager.requestEnableNotification(this.context).then(() => {
      hilog.info(DOMAIN, 'FluxDownCover', '%{public}s', 'Notification permission granted');
    }).catch((e: Error) => {
      hilog.warn(DOMAIN, 'FluxDownCover', 'Notification permission denied: %{public}s', e.message);
    });
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
    // 完全按照原项目方式：先异步配置窗口，加载内容后再次配置
    this.configureWindow(windowStage).finally(() => {
      windowStage.loadContent('pages/SplashPage', (err) => {
        if (err.code) {
          hilog.error(DOMAIN, 'FluxDownCover', 'Failed to load pages/SplashPage: %{public}s', JSON.stringify(err));
          return;
        }
        this.configureWindow(windowStage);
        hilog.info(DOMAIN, 'FluxDownCover', '%{public}s', 'pages/SplashPage loaded');
      });
    });
  }

  /** 完全按照原项目方式：异步配置窗口（全屏布局+窗口背景色+透明系统栏+安全区域） */
  private async configureWindow(windowStage: window.WindowStage): Promise<void> {
    try {
      const mainWindow = windowStage.getMainWindowSync();
      this.mainWindow = mainWindow;
      const isDark = this.isDarkMode(this.context.config.colorMode);
      // 用await等待异步操作完成，避免窗口状态异常
      await mainWindow.setWindowLayoutFullScreen(true);
      await this.configureWindowAppearance(mainWindow, isDark);
      this.publishColorMode(this.context.config.colorMode);
      this.syncSafeArea(mainWindow);
      // 监听 App 内手动切换主题（深色/浅色），同步窗口背景色，避免底部安全区透出旧窗口背景
      if (!this.hasAppThemeListener) {
        this.hasAppThemeListener = true;
        setInterval(() => {
          const theme = AppStorage.get<string>('fluxdown_app_theme');
          if (theme && theme !== this.lastAppTheme && this.mainWindow) {
            this.lastAppTheme = theme;
            this.configureWindowAppearance(this.mainWindow, theme === 'dark');
          }
        }, 300);
      }
      if (!this.hasSafeAreaListener) {
        mainWindow.on('avoidAreaChange', (avoidAreaOption) => {
          if (avoidAreaOption.type === window.AvoidAreaType.TYPE_SYSTEM ||
            avoidAreaOption.type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR) {
            this.syncSafeArea(mainWindow);
          }
        });
        this.hasSafeAreaListener = true;
      }
    } catch (err) {
      hilog.error(DOMAIN, 'FluxDownCover', 'Failed to configure window: %{public}s', JSON.stringify(err));
    }
  }

  /** 深色/浅色模式切换时统一更新窗口外观（原项目方式） */
  onConfigurationUpdate(newConfig: Configuration): void {
    const isDark = this.isDarkMode(newConfig.colorMode);
    this.publishColorMode(newConfig.colorMode);
    if (this.mainWindow) {
      this.configureWindowAppearance(this.mainWindow, isDark);
    }
  }

  private publishColorMode(colorMode?: ConfigurationConstant.ColorMode): void {
    const isDark = this.isDarkMode(colorMode);
    AppStorage.setOrCreate<boolean>('fluxdown_systemDark', isDark);
  }

  private isDarkMode(colorMode?: ConfigurationConstant.ColorMode): boolean {
    return colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }

  /** 设置窗口背景色和透明系统栏（原项目方式，用await避免窗口状态异常） */
  private async configureWindowAppearance(mainWindow: window.Window, isDark: boolean): Promise<void> {
    try {
      mainWindow.setWindowBackgroundColor(isDark ? '#FF000000' : '#FFE8EBF0');
      await mainWindow.setWindowSystemBarProperties({
        statusBarColor: TRANSPARENT_SYSTEM_BAR,
        navigationBarColor: isDark ? '#FF000000' : '#FFE8EBF0',
        isStatusBarLightIcon: isDark,
        isNavigationBarLightIcon: isDark,
        navigationBarContentColor: isDark ? '#FFEEEEEE' : '#FF1A1A1A',
        statusBarContentColor: isDark ? '#FFEEEEEE' : '#FF1A1A1A'
      });
    } catch (err) {
      hilog.error(DOMAIN, 'FluxDownCover', 'Failed to update window colors: %{public}s', JSON.stringify(err));
    }
  }

  /** 获取状态栏和导航栏高度，发布到AppStorage（原项目方式） */
  private syncSafeArea(mainWindow: window.Window): void {
    try {
      const uiContext = mainWindow.getUIContext();
      const systemAvoidArea = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const naviAvoidArea = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      AppStorage.setOrCreate<number>(
        STATUS_BAR_HEIGHT_KEY,
        uiContext.px2vp(systemAvoidArea?.topRect?.height ?? 0)
      );
      AppStorage.setOrCreate<number>(
        NAVI_INDICATOR_HEIGHT_KEY,
        uiContext.px2vp(naviAvoidArea?.bottomRect?.height ?? 0)
      );
    } catch (err) {
      hilog.error(DOMAIN, 'FluxDownCover', 'Failed to sync safe area: %{public}s', JSON.stringify(err));
    }
  }
}
