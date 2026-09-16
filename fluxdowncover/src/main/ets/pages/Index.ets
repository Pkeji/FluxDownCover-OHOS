import { LengthMetrics, curves, UIContext } from '@kit.ArkUI';
import { HdsTabs, HdsTabsController, HdsTabsFloatingStyle, HdsBarStyle, HdsTabsBarChangeMode, hdsMaterial, SystemMaterialParams, HdsNavigation, HdsNavigationTitleMode, HdsNavigationMenuContentOptions, ScrollEffectType, BlurStrategy } from '@kit.UIDesignKit';
import { ImmersionButton, ImmersionSearch } from '@tangs/components';
import { ButtonModifier } from '@kit.ArkUI';
import { window } from '@kit.ArkUI';
import { common, Want, OpenLinkOptions, ConfigurationConstant, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import bundleManager from '@ohos.bundle.bundleManager';
import { picker, fileUri } from '@kit.CoreFileKit';
import { wantConstant } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { pasteboard } from '@kit.BasicServicesKit';
import fs from '@ohos.file.fs';
import { photoAccessHelper } from '@kit.MediaLibraryKit';

import { DownloadViewModel } from '../viewmodel/DownloadViewModel';
import { DownloadTask, Segment } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';
import { formatBytes, formatSpeed, formatDateTime, formatDuration, detectProtocol, protocolMeta, ALL_PROTOCOLS, fileNameFromUrl, ProtocolMeta, BUILTIN_CATEGORIES, BuiltinCategory, fileTypeMeta } from '../utils/common';
import { checkForUpdate, APP_VERSION, ReleaseInfo } from '../utils/VersionChecker';
import { logCollector } from '../utils/LogCollector';
import { COLOR_SCHEMES, getScheme, ColorScheme } from '../utils/ColorSchemes';
import { probeHlsVariants } from '../engine/protocols/HlsProtocol';
import { DownloadQueue } from '../model/DownloadQueue';
import { DownloadCategory } from '../model/DownloadCategory';
import { RssSubscription } from '../model/RssSubscription';
import { SeedConditionOperator } from '../store/BtSettingsStore';
import dataPreferences from '@ohos.data.preferences';
import { deviceInfo } from '@kit.BasicServicesKit';
import { PRIVACY_SUMMARY, PRIVACY_SECTIONS, PRIVACY_APP_NAME, PRIVACY_UPDATE_DATE, PRIVACY_CONTACT_EMAIL, PrivacySection, APP_ICP_RECORD } from '../utils/PrivacyPolicy';

// 提取到 components/ 的共享 UI 层
import { Palette, palette, iconRes, safeToast, ActionButtonModifier, ImmersionButtonModifier,
  materialBorder, buildMaterialEffect, statusText, protocolIcon, protocolLabelIcon, statusIcon,
  withAlpha, softShadow, PRESS_SCALE, PRESS_SCALE_STRONG, PRESS_DURATION,
  RADIUS_CARD, RADIUS_SHEET, MATERIAL_BORDER_WIDTH, MATERIAL_BLUR,
  SHEET_OPEN_DURATION, SHEET_CLOSE_DURATION } from './components/SharedUI';

// 提取到 components/ 的独立组件
import FilterChipComponent from './components/FilterChipComponent';
import AuthorAvatar from './components/AuthorAvatar';
import AboutContent from './components/AboutContent';
import TaskDetailContent from './components/TaskDetailContent';
import StatsContent from './components/StatsContent';

interface TaskGroup {
  label: string;
  tasks: DownloadTask[];
}

/** 搜索框修饰器（参考 OpenAuthenticator 的 HomeSearchModifier） */
class HomeSearchModifier implements AttributeModifier<SearchAttribute> {
  private textColor: ResourceColor;
  private hintColor: ResourceColor;
  private change: (value: string) => void;

  constructor(textColor: ResourceColor, hintColor: ResourceColor, change: (value: string) => void) {
    this.textColor = textColor;
    this.hintColor = hintColor;
    this.change = change;
  }

  applyNormalAttribute(instance: SearchAttribute): void {
    instance.fontColor(this.textColor)
      .placeholderColor(this.hintColor)
      .onWillChange((value: EditableTextChangeValue): boolean => {
        this.change(value.content);
        return true;
      });
  }
}

/**
 * 同步应用级颜色模式（ApplicationContext.setColorMode，API18，主线程）。
 * App 内手动切深色/浅色时必须调用：HDS 组件（HdsTabs/HdsNavigation）与系统毛玻璃材质
 * 只认系统/UIContext 的 colorMode，不看应用内自定义调色板；若不同步，底部导航/安全区
 * 仍按系统模式渲染而留白。mode='system' 时还原 NOT_SET，交回系统控制。
 */
function applyAppColorMode(ctx: common.UIAbilityContext, mode: 'light' | 'dark' | 'system'): void {
  try {
    const appCtx = ctx.getApplicationContext();
    if (mode === 'dark') {
      appCtx.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
    } else if (mode === 'light') {
      appCtx.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
    } else {
      appCtx.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    }
  } catch (_e) {}
}

interface HlsVariantResult {
  urls: string[];
  labels: string[];
}

@Entry
@ComponentV2
struct IndexPage {
  @Local vm: DownloadViewModel = new DownloadViewModel();
  navPathStack: NavPathStack = new NavPathStack();
  @Local currentTab: number = 0;
  /** 底部主导航当前页：0=下载（任务列表），1=我的（设置） */
  @Local currentMainTab: number = 0;
  @Local winWidth: number = 0; // current window width (vp) for responsive layout
  /** 底部导航指示器（安全区域）高度，由 EntryAbility 发布到 AppStorage */
  @Local naviIndicatorHeight: number = 0;
  /** 顶部状态栏高度，由 EntryAbility 发布到 AppStorage（用于内容避让悬浮标题栏） */
  @Local statusBarHeight: number = 0;
  @Local centerToast: string = '';
  @Local centerToastTimer: number = -1;
  @Local showAddSheet: boolean = false;
  @Local sheetScale: number = 1;
  @Local sheetOpacity: number = 1;
  @Local showFilterSheet: boolean = false;
  @Local filterSheetScale: number = 1;
  @Local filterSheetOpacity: number = 1;
  @Local searchMode: boolean = false;
  // FAB（右下角加号）在窗口中的中心坐标，用于让新建弹窗的缩放动画始终从加号位置展开
  @Local fabCenterX: number = 0;
  @Local fabCenterY: number = 0;
  // 新建弹窗左上角在窗口中的坐标（居中布局，随窗口尺寸变化）
  @Local addSheetOriginX: number = 0;
  @Local addSheetOriginY: number = 0;
  // HdsTabs 控制器（控制 miniBar 收缩/展开）
  private tabsController: HdsTabsController = new HdsTabsController();
  // 首次启动等 vm.init 完成后再渲染主界面（避免白屏）
  @Local pageReady: boolean = false;
  // 新建下载弹窗拖动偏移（按住垂直拖动，松手回弹）
  @Local addSheetDragY: number = 0;
  // 当前被按下的可点卡片 key（统一物理按压反馈），空串表示无
  @Local pressedKey: string = '';
  // 光影拖动效果：当前显示光影的按钮key，以及光影相对于按钮中心的偏移
  @Local glowKey: string = '';
  @Local glowX: number = 0;
  @Local glowY: number = 0;
  @Local qqGroupSheetVisible: boolean = false;
  // 隐私政策：首启同意弹窗、隐私政策全文页
  @Local showPrivacyDialog: boolean = false;
  @Local showPrivacyPage: boolean = false;
  @Local privacyChecked: boolean = false;
  private privacyPrefs: dataPreferences.Preferences | null = null;
  @Local selectMode: boolean = false;
  @Local selectedTaskIds: Set<string> = new Set();
  @Local updateInfo: ReleaseInfo | null = null;
  /** 检查更新加载态（即时反馈） */
  @Local isCheckingUpdate: boolean = false;
  @Local checkUpdateStatus: string = '';
  private deepLinkTimer: number = -1;
  // 下载中图标旋转动画
  @Local rotateAngle: number = 0;
  private rotateTimer: number = -1;
  /** 最近一次同步到窗口外观的主题（light/dark），用于检测手动切换后需更新窗口背景 */
  private lastWindowTheme: 'light' | 'dark' | null = null;
  private contextMenuTask: DownloadTask | null = null;
  // Rename / move dialog state
  @Local renameDialogVisible: boolean = false;
  @Local renameTarget: DownloadTask | null = null;
  @Local renameDraft: string = '';
  @Local moveDialogVisible: boolean = false;
  @Local moveTarget: DownloadTask | null = null;
  @Local moveDraft: string = '';

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  /** 框架图标颜色：跟随外观设置「图标着色」——主题色 / 中性单色 */
  @Computed
  get tintColor(): string {
    return this.vm.iconTint === 'mono' ? this.p.text : this.p.primary;
  }

  /**
   * 是否为 PC/2in1（键鼠、非触控大屏）。
   * 适配原则：手机（含折叠屏）与平板同为触控，共用同一套移动布局；仅 2in1 启用大屏框架
   * （宽悬浮导航、关闭系统材质、更大的标题栏等），避免平板横屏被误判成 PC。
   */
  get is2in1(): boolean {
    return deviceInfo.deviceType === '2in1';
  }

  /** 界面材质：跟随外观设置；仅 PC/2in1 无触摸拖拽，系统材质会停在发白初始态而强制关闭；手机与平板保留材质动效 */
  private appMaterialEffect(): SystemMaterialParams {
    if (this.is2in1) {
      return { materialType: hdsMaterial.MaterialType.NONE, materialLevel: hdsMaterial.MaterialLevel.ADAPTIVE };
    }
    return buildMaterialEffect(this.vm.glassStyle, this.vm.glassLevel);
  }

  /**
   * 新建弹窗的缩放锚点（相对弹窗自身左上角，单位 vp）。
   * 等于“加号中心的窗口坐标 − 弹窗左上角的窗口坐标”，因此无论窗口如何缩放、
   * 弹窗居中到何处，放大动画都从右下角加号的位置展开（PC/平板/手机一致）。
   * 尚未测量到时回退到弹窗自身右下角（'100%'）。
   */
  @Computed
  get addSheetPivotX(): number | string {
    return '50%';
  }

  @Computed
  get addSheetPivotY(): number | string {
    return '50%';
  }

  /** 统一按压反馈：按下时返回 PRESS_SCALE，否则 1 */
  private pressScale(key: string): number {
    return this.pressedKey === key ? PRESS_SCALE : 1;
  }

  /** 统一按压反馈：绑定到 onTouch，Down 记录、Up/Cancel 释放 */
  private handlePress(key: string, event: TouchEvent): void {
    if (event.type === TouchType.Down) {
      this.pressedKey = key;
      this.glowKey = key;
      const touch = event.touches[0];
      if (touch) {
        this.glowX = touch.x - 17;
        this.glowY = touch.y - 17;
      }
    } else if (event.type === TouchType.Move && this.glowKey === key) {
      const touch = event.touches[0];
      if (touch) {
        this.glowX = touch.x - 17;
        this.glowY = touch.y - 17;
      }
    } else if ((event.type === TouchType.Up || event.type === TouchType.Cancel) && this.pressedKey === key) {
      this.pressedKey = '';
      this.glowKey = '';
      this.glowX = 0;
      this.glowY = 0;
    }
  }

  /** 弹窗打开时系统栏透明（蒙层透出），关闭时恢复 */
  private async setSystemBarForSheet(show: boolean): Promise<void> {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const win = await window.getLastWindow(ctx);
      if (show) {
        await win.setWindowSystemBarProperties({
          navigationBarColor: '#4D000000',
          isNavigationBarLightIcon: true,
        });
      } else {
        await win.setWindowSystemBarProperties({
          navigationBarColor: this.p.bg,
        });
      }
    } catch (e) {
      // ignore
    }
  }

  openAddSheet(): void {
    this.sheetScale = 0.08;
    this.sheetOpacity = 0;
    this.showAddSheet = true;
    setTimeout(() => {
      this.setSystemBarForSheet(true);
      this.getUIContext().animateTo({
        duration: SHEET_OPEN_DURATION,
        curve: curves.cubicBezierCurve(0.3, 1.12, 0.4, 1),
      }, () => {
        this.sheetScale = 1;
        this.sheetOpacity = 1;
      });
    }, 16);
  }

  closeAddSheet(): void {
    this.getUIContext().animateTo({
      duration: SHEET_CLOSE_DURATION,
      curve: Curve.EaseIn,
      onFinish: () => {
        this.showAddSheet = false;
        this.sheetScale = 1;
        this.sheetOpacity = 1;
        this.setSystemBarForSheet(false);
      },
    }, () => {
      this.sheetScale = 0.08;
      this.sheetOpacity = 0;
    });
  }

  openFilterSheet(): void {
    this.filterSheetScale = 0.08;
    this.filterSheetOpacity = 0;
    this.showFilterSheet = true;
    setTimeout(() => {
      this.getUIContext().animateTo({
        duration: SHEET_OPEN_DURATION,
        curve: curves.cubicBezierCurve(0.3, 1.12, 0.4, 1),
      }, () => {
        this.filterSheetScale = 1;
        this.filterSheetOpacity = 1;
      });
    }, 16);
  }

  closeFilterSheet(): void {
    this.getUIContext().animateTo({
      duration: SHEET_CLOSE_DURATION,
      curve: Curve.EaseIn,
      onFinish: () => {
        this.showFilterSheet = false;
        this.filterSheetScale = 1;
        this.filterSheetOpacity = 1;
      },
    }, () => {
      this.filterSheetScale = 0.08;
      this.filterSheetOpacity = 0;
    });
  }

  aboutToAppear(): void {
    // 首启隐私协议弹窗已移至 SplashPage.ets，此处不再重复弹窗。
    // SplashPage 在用户点击"同意"后设置 privacyAgreed 并 emit 'privacyAgreed' 事件，
    // 然后 navigate 到本页。若用户点击"不同意"则 terminateSelf，不会进入本页。
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    // LogCollector 是普通类、没有 UIContext；全局 promptAction.showToast 已废弃，
    // 这里把 UIContext 注入给它，报错提示改走 UIContext.getPromptAction()
    logCollector.attachUIContext(this.getUIContext());
    this.syncSafeAreaFromStorage();
    dataPreferences.getPreferences(context, 'fluxdown_settings').then((prefs: dataPreferences.Preferences) => {
      this.privacyPrefs = prefs;
      prefs.get('privacyAgreed', false).then((v) => {
        const agreed = v === true;
        this.privacyChecked = true;
        if (agreed) {
          this.startApp(context);
        } else {
          // 兜底：非正常流程进入（如热启动/深链接）且未同意时，仍显示弹窗
          this.showPrivacyDialog = true;
        }
      }).catch(() => {
        this.privacyChecked = true;
        this.showPrivacyDialog = true;
      });
    }).catch(() => {
      this.privacyChecked = true;
      this.showPrivacyDialog = true;
    });
  }

  /** 用户同意隐私政策：记录同意状态并启动业务 */
  private agreePrivacy(): void {
    if (this.privacyPrefs) {
      try {
        this.privacyPrefs.put('privacyAgreed', true);
        this.privacyPrefs.flush();
      } catch (e) {
        console.warn(`[Index] persist privacyAgreed failed: ${(e as Error)?.message ?? e}`);
      }
    }
    AppStorage.setOrCreate<boolean>('fluxdown_privacyAgreed', true);
    // 通知 EntryAbility 启动下载/BT 联网引擎、申请通知权限
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    ctx.eventHub.emit('privacyAgreed');
    this.showPrivacyDialog = false;
    this.startApp(ctx);
  }

  /** 用户拒绝隐私政策：退出应用 */
  private refusePrivacy(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      context.terminateSelf();
    } catch (e) {
      console.warn(`[Index] terminateSelf failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /** 隐私同意后真正启动业务（原 aboutToAppear 逻辑） */
  private startApp(context: common.UIAbilityContext): void {
    // 底部安全区域高度由 EntryAbility 发布到 AppStorage，在 tabsFloatingStyle 中实时读取
    this.vm.init(context).then(() => {
      // vm 初始化完成（主题、配置、数据已加载）后再渲染主界面，避免首次启动白屏
      // 先按用户上次选择同步应用级颜色模式，保证 HDS/系统材质首帧即正确、底部不留白
      applyAppColorMode(context, this.vm.themeMode);
      this.pageReady = true;
      // 双保险：直接同步窗口背景色 + 通知 EntryAbility 轮询同步
      this.applyWindowAppearance(this.vm.theme === 'dark');
      AppStorage.setOrCreate<string>('fluxdown_app_theme', this.vm.theme);
    }).catch((e: Error) => {
      logCollector.error('Init', `VM init failed: ${e?.message || String(e)}`);
      // 即使初始化失败也渲染主界面，避免一直白屏
      this.pageReady = true;
    });
    // Process any pending deep-link URL from cold start
    this.handlePendingDeepLink();
    // Poll for warm-start deep links (onNewWant updates AppStorage)
    this.deepLinkTimer = setInterval(() => {
      this.handlePendingDeepLink();
      this.updateSystemTheme();
      this.syncWindowAppearance();
      this.syncSafeAreaFromStorage();
    }, 500);
    // Auto-update check removed to avoid triggering system "downloading" notification.
    // Manual check only via About page "检查更新" button.
    // 启动下载中图标旋转动画
    this.rotateTimer = setInterval(() => {
      this.rotateAngle = (this.rotateAngle + 15) % 360;
    }, 80) as number;
  }

  aboutToDisappear(): void {
    if (this.deepLinkTimer >= 0) {
      clearInterval(this.deepLinkTimer);
      this.deepLinkTimer = -1;
    }
    if (this.rotateTimer >= 0) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = -1;
    }
  }

  /** Check AppStorage for a pending download URL from deep link / share. */
  private handlePendingDeepLink(): void {
    const url = AppStorage.get<string>('pendingDownloadUrl');
    if (url && url.length > 0) {
      // Clear immediately to avoid re-processing
      AppStorage.setOrCreate<string>('pendingDownloadUrl', '');
      // Auto-add the download
      this.vm.addDownload(url).then((result: 'added' | 'duplicate' | 'pending' | 'skipped') => {
        if (result === 'duplicate') {
          // 重复链接：显示询问对话框
          this.showDuplicateDialog();
        } else if (result === 'added') {
          safeToast(this.getUIContext(), '已从浏览器扩展接收链接，开始下载' );
        }
        // pending：正在添加中，不显示 toast
      }).catch((e: Error) => {
        safeToast(this.getUIContext(), '链接接收失败: ' + (e?.message || String(e)) );
      });
    }
  }

  /** 同步窗口背景色和系统栏属性（App内手动切换主题时调用，避免底部安全区透出旧窗口背景色） */
  private applyWindowAppearance(isDark: boolean): void {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      window.getLastWindow(ctx).then((win: window.Window) => {
        win.setWindowBackgroundColor(isDark ? '#FF000000' : '#FFE8EBF0');
        win.setWindowSystemBarProperties({
          statusBarColor: '#00000000',
          navigationBarColor: isDark ? '#FF000000' : '#FFE8EBF0',
          isStatusBarLightIcon: isDark,
          isNavigationBarLightIcon: isDark,
          navigationBarContentColor: isDark ? '#FFEEEEEE' : '#FF1A1A1A',
          statusBarContentColor: isDark ? '#FFEEEEEE' : '#FF1A1A1A'
        });
      }).catch((_e: Error) => {});
    } catch (_e) {}
  }

  /** Apply system brightness to the active theme when "跟随系统" is selected. */
  private updateSystemTheme(): void {
    if (this.vm.themeMode !== 'system') {
      return;
    }
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const isDark = ctx.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
      const target: 'light' | 'dark' = isDark ? 'dark' : 'light';
      if (this.vm.theme !== target) {
        this.vm.setTheme(target);
        this.applyWindowAppearance(isDark);
      }
    } catch (e) {
      // config unavailable — keep current theme
    }
  }

  /** 检测当前主题变化并同步到窗口外观（覆盖手动切换深色/浅色场景） */
  private syncWindowAppearance(): void {
    try {
      const theme = this.vm.theme;
      if (theme !== this.lastWindowTheme) {
        this.applyWindowAppearance(theme === 'dark');
        this.lastWindowTheme = theme;
      }
    } catch (_e) {}
  }

  /** 从 AppStorage 读取顶部状态栏/底部导航安全区高度（EntryAbility 发布），驱动内容避让重绘 */
  private syncSafeAreaFromStorage(): void {
    const sb = AppStorage.get<number>('fluxdown_statusBarHeight') ?? 0;
    const nb = AppStorage.get<number>('fluxdown_naviIndicatorHeight') ?? 0;
    if (sb !== this.statusBarHeight) {
      this.statusBarHeight = sb;
    }
    if (nb !== this.naviIndicatorHeight) {
      this.naviIndicatorHeight = nb;
    }
  }

  private async checkForUpdate(silent: boolean = false): Promise<void> {
    this.isCheckingUpdate = true;
    this.checkUpdateStatus = '';
    if (!silent) {
      this.showCenterToast('正在检查更新…');
    }
    try {
      const info = await checkForUpdate(
        APP_VERSION, this.vm.proxyConfig(), this.vm.ignoreTlsErrors, this.vm.githubMirrorUrl,
        (status) => {
          this.checkUpdateStatus = status;
          logCollector.info('Update', status);
        }
      );
      if (info) {
        logCollector.info('Update', `发现新版本: ${info.version}`);
        this.updateInfo = info;
        this.showUpdateDialog();
      } else if (!silent && !this.updateInfo) {
        // checkForUpdate 已通过 onStatus 反馈「已是最新版本」或「所有节点均不可达」
        // 当 silent=false 且没有发现新版本时，显示最终状态
        if (this.checkUpdateStatus && this.checkUpdateStatus !== '') {
          this.showCenterToast(this.checkUpdateStatus);
        } else {
          this.showCenterToast('已是最新版本');
        }
      }
    } catch (e) {
      logCollector.error('Update', `检查更新失败: ${JSON.stringify(e)}`);
      if (!silent) {
        this.showCenterToast(this.checkUpdateStatus || '检查更新失败，请检查网络');
      }
    } finally {
      this.isCheckingUpdate = false;
    }
  }

  /** Centered floating toast — always horizontally/vertically centered regardless of window size. */
  private showCenterToast(msg: string): void {
    this.centerToast = msg;
    if (this.centerToastTimer >= 0) {
      clearTimeout(this.centerToastTimer);
    }
    this.centerToastTimer = setTimeout(() => {
      this.centerToast = '';
    }, 2200);
  }

  /** 检测到重复下载链接时弹出询问对话框（IndexPage 版本，用于深度链接）。 */
  private showDuplicateDialog(): void {
    const info = this.vm.duplicatePrompt;
    if (!info) {
      return;
    }
    this.getUIContext().showAlertDialog({
      title: '重复下载',
      message: `链接「${info.url.length > 60 ? info.url.slice(0, 57) + '...' : info.url}」\n已存在下载任务，是否重新下载？原文件将保留。`,
      autoCancel: false,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '跳过',
        action: () => {
          this.vm.confirmDuplicateDownload('skip');
        }
      },
      secondaryButton: {
        value: '重新下载',
        fontColor: this.p.primary,
        action: () => {
          this.vm.confirmDuplicateDownload('redownload').then(() => {
            safeToast(this.getUIContext(), '已重新添加下载任务' );
          });
        }
      }
    });
  }

  private showUpdateDialog(): void {
    const info = this.updateInfo;
    if (!info) return;
    this.getUIContext().showAlertDialog({
      title: `发现新版本 ${info.tagName}`,
      message: `更新内容：\n${info.summary}`,
      autoCancel: true,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '稍后再说',
        action: () => {}
      },
      secondaryButton: {
        value: '下载更新',
        fontColor: this.p.primary,
        action: () => {
          if (info.downloadUrl) {
            this.vm.addDownload(info.downloadUrl).then((result: 'added' | 'duplicate' | 'pending' | 'skipped') => {
              if (result === 'duplicate') {
                this.showDuplicateDialog();
                return;
              }
              if (result === 'added') {
                safeToast(this.getUIContext(), '已添加更新下载任务' );
                this.currentTab = 0;
              }
            }).catch((e: Error) => {
              safeToast(this.getUIContext(), '添加下载失败' );
            });
          } else {
            safeToast(this.getUIContext(), '未找到安装包下载地址' );
          }
        }
      }
    });
  }

  private async openFile(task: DownloadTask): Promise<void> {
    try {
      // Ensure file is exported first
      if (!task.publicPath) {
        await this.vm.exportToDownload(task);
      }
      const fileUriObj = fileUri.getUriFromPath(task.publicPath);
      const want: Want = {
        action: 'ohos.want.action.viewData',
        uri: fileUriObj,
        flags: wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION | wantConstant.Flags.FLAG_AUTH_WRITE_URI_PERMISSION,
      };
      (this.getUIContext().getHostContext() as common.UIAbilityContext).startAbility(want);
    } catch (e) {
      safeToast(this.getUIContext(), '打开文件失败: ' + ((e as Error)?.message || String(e)) );
    }
  }

  private async openFileLocation(task: DownloadTask): Promise<void> {
    try {
      if (!task.publicPath) {
        await this.vm.exportToDownload(task);
      }
      // Use openLink to open the system file manager at the file's directory
      const fileUriObj = fileUri.getUriFromPath(task.publicPath);
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      ctx.openLink('filemanager://openDirectory', {
        parameters: { 'fileUri': fileUriObj }
      } as OpenLinkOptions);
    } catch (e) {
      safeToast(this.getUIContext(), '打开文件目录失败: ' + ((e as Error)?.message || String(e)) );
    }
  }

  @Computed
  get visibleTasks(): DownloadTask[] {
    return this.vm.visibleTasks;
  }

  /** 手动计算分组，不用@Computed，避免依赖追踪失效 */
  computeGroupedTasks(): TaskGroup[] {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const groups: TaskGroup[] = [
      { label: '今天', tasks: [] },
      { label: '昨天', tasks: [] },
      { label: '更早', tasks: [] },
    ];
    for (const t of this.vm.visibleTasks) {
      if (t.createdAt >= todayStart) groups[0].tasks.push(t);
      else if (t.createdAt >= yesterdayStart) groups[1].tasks.push(t);
      else groups[2].tasks.push(t);
    }
    return groups.filter(g => g.tasks.length > 0);
  }

  /** HdsNavigation 当前页面标题（完全按照原项目 currentHomeTitle 方式） */
  private currentHomeTitle(): string {
    if (this.currentMainTab === 1) {
      return '设置';
    }
    if (this.currentMainTab === 2) {
      return '关于';
    }
    return 'FluxDown Cover';
  }

  /** HdsNavigation 右上角菜单（完全按照原项目 homeSearchMenu 方式，HdsNavigationMenuContentOptions 格式） */
  private homeSearchMenu(): HdsNavigationMenuContentOptions {
    if (this.currentMainTab !== 0) {
      return { value: [], maxCount: 0 };
    }
    return {
      value: [
        {
          content: {
            icon: iconRes('sliders'),
            label: '筛选',
            action: () => { this.openFilterSheet(); }
          }
        },
        {
          content: {
            icon: iconRes(this.hasActiveTasks ? 'pause' : 'play'),
            label: this.hasActiveTasks ? '全部暂停' : '全部开始',
            action: () => {
              if (this.hasActiveTasks) {
                this.vm.pauseAll();
              } else {
                this.vm.resumeAllTasks();
              }
            }
          }
        }
      ],
      maxCount: 2
    };
  }

  @Builder
  NavigationTitle() {
    Row() {
      if (this.currentMainTab === 1) {
        // ── 我的：与下载页同款标题栏（图标 + 标题），配色一致 ──
        Image(iconRes('user'))
          .width(28).height(28).fillColor(this.tintColor)
          .margin({ left: 16, right: 10 })

        Text('设置')
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.p.text)
      } else if (this.searchMode) {
        ImmersionSearch({
          systemMaterialEffect: this.appMaterialEffect(),
          _height: 40,
          options: { placeholder: '搜索下载任务' },
          modifier: new HomeSearchModifier(
            this.p.text,
            this.p.textSecondary,
            (value: string): void => {
              this.vm.setSearchQuery(value);
            }
          )
        })
        .height(40)
        .layoutWeight(1)
        .margin({ left: 16, right: 12 })
        .clip(false)
        Text('取消')
          .fontSize(15).fontColor(this.p.primary)
          .margin({ right: 16 })
          .onClick(() => {
            this.searchMode = false;
            this.vm.setSearchQuery('');
          })
      } else if (this.currentMainTab === 2) {
        // ── 关于：与设置同款标题栏（图标 + 标题） ──
        Image(iconRes('info'))
          .width(28).height(28).fillColor(this.tintColor)
          .margin({ left: 16, right: 10 })

        Text('关于')
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.p.text)
      } else {
        Image(iconRes('download'))
          .width(28).height(28).fillColor(this.tintColor)
          .margin({ left: 16, right: 10 })

        Column() {
          Text('FluxDown Cover')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.p.text)
          Text(this.titleSubtitle)
            .fontSize(13)
            .fontColor(this.p.textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .height(this.is2in1 ? 44 : 56)
  }

  @Computed
  get titleSubtitle(): string {
    const active = this.vm.tasks.filter((t: DownloadTask) => t.status === TaskStatus.Downloading || t.status === TaskStatus.Queued || t.status === TaskStatus.Merging || t.status === TaskStatus.Verifying).length;
    if (active > 0) {
      const speed = this.vm.tasks.reduce((sum: number, t: DownloadTask) => sum + t.speed, 0);
      return `${formatSpeed(speed)} · ${active} 个任务`;
    }
    return '空闲';
  }

  @Builder
  PageTitle(title: string) {
    Row() {
      Text(title)
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.p.text)
    }
    .width('100%')
    .height(56)
  }

  @Builder
  SubPageHeader(title: string, icon: string) {
    Row() {
      if (icon === 'chevron_left') {
        Image(iconRes('chevron_right'))
          .width(26).height(26).fillColor(this.p.text)
          .rotate({ angle: 180 })
          .margin({ left: 8, right: 8 })
          .onClick(() => { this.navPathStack.pop(); })
      } else {
        Image(iconRes(icon))
          .width(26).height(26).fillColor(this.p.text)
          .margin({ left: 8, right: 8 })
          .onClick(() => { this.navPathStack.pop(); })
      }
      Text(title)
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.p.text)
        .layoutWeight(1)
    }
    .width('100%')
    // 子页隐藏了系统标题栏且 Navigation 忽略顶部安全区，需手动让出状态栏高度，返回按钮才不会顶到导航栏/状态栏
    .padding({ top: this.statusBarHeight })
    .height(56 + this.statusBarHeight)
  }

  @Builder
  NavigationMenus() {
    Row() {
      if (this.currentMainTab === 1) {
        // 我的页：无菜单，保持顶栏简洁
      } else {
        // 搜索按钮（参考对比项目FAB：透明Button + 毛玻璃背景 + clip(false)）
        Stack({ alignContent: Alignment.Center }) {
          Button() {
            Image(iconRes('search'))
              .width(22).height(22).fillColor(this.p.dark ? '#FFFFFFFF' : '#FF000000')
          }
          .width(44).height(44)
          .backgroundColor(Color.Transparent)
          .onClick(() => { this.searchMode = !this.searchMode; })
        }
        .width(44).height(44)
        .borderRadius(22)
        .backgroundColor(withAlpha(this.p.surface, 0.7))
        .backgroundBlurStyle(MATERIAL_BLUR)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .margin({ right: 12 })
        .clip(false)

        // 筛选按钮（参考对比项目FAB：透明Button + 毛玻璃背景 + clip(false)）
        Stack({ alignContent: Alignment.Center }) {
          Button() {
            Image(iconRes('sliders'))
              .width(22).height(22).fillColor(this.p.dark ? '#FFFFFFFF' : '#FF000000')
          }
          .width(44).height(44)
          .backgroundColor(Color.Transparent)
          .onClick(() => { this.openFilterSheet(); })
        }
        .width(44).height(44)
        .borderRadius(22)
        .backgroundColor(withAlpha(this.p.surface, 0.7))
        .backgroundBlurStyle(MATERIAL_BLUR)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .margin({ right: 12 })
        .clip(false)

        // 全暂停/恢复按钮（参考对比项目FAB：透明Button + 毛玻璃背景 + clip(false)）
        Stack({ alignContent: Alignment.Center }) {
          Button() {
            Image(iconRes(this.hasActiveTasks ? 'pause' : 'play'))
              .width(22).height(22).fillColor(this.p.dark ? '#FFFFFFFF' : '#FF000000')
          }
          .width(44).height(44)
          .backgroundColor(Color.Transparent)
          .onClick(() => {
            if (this.hasActiveTasks) {
              this.vm.pauseAll();
            } else {
              this.vm.resumeAllTasks();
            }
          })
        }
        .width(44).height(44)
        .borderRadius(22)
        .backgroundColor(withAlpha(this.p.surface, 0.7))
        .backgroundBlurStyle(MATERIAL_BLUR)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .clip(false)
      }
    }
    .width('100%')
    .height(56)
    .alignItems(VerticalAlign.Center)
    .padding({ right: 16 })
    .justifyContent(FlexAlign.End)
  }

  @Computed
  get hasActiveTasks(): boolean {
    return this.vm.tasks.some((t: DownloadTask) => t.status === TaskStatus.Downloading || t.status === TaskStatus.Queued || t.status === TaskStatus.Merging || t.status === TaskStatus.Verifying);
  }

  /** 底部主导航悬浮胶囊内按钮（参考 OpenAuthenticator HomeTab：图标 + 标签，选中主色） */
  @Builder
  MainTabButton(index: number, icon: string, label: string) {
    Column() {
      Image(iconRes(icon))
        .width(21).height(21)
        .fillColor(this.currentMainTab === index ? this.tintColor : this.p.textSecondary)
        .animation({ duration: 250, curve: Curve.Smooth })
      Text(label)
        .fontSize(11)
        .fontWeight(this.currentMainTab === index ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.currentMainTab === index ? this.tintColor : this.p.textSecondary)
        .margin({ top: 2 })
        .animation({ duration: 250, curve: Curve.Smooth })
    }
    .width('50%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .scale({ x: this.pressedKey === ('tab' + index) ? 0.93 : 1, y: this.pressedKey === ('tab' + index) ? 0.93 : 1 })
    .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
    .onTouch((event: TouchEvent) => {
      this.handlePress('tab' + index, event);
    })
    .onClick(() => {
      if (this.currentMainTab !== index) {
        this.currentMainTab = index;
        if (index !== 0) {
          this.selectMode = false;
          this.selectedTaskIds = new Set();
        }
      }
    })
  }

  /** HdsTabs 下载 Tab 样式（参考项目 BottomTabBarStyle：图标+文字，选中主色） */
  /** HdsTabs 下载 Tab（自定义，去掉系统矩形点击高亮） */
  @Builder
  downloadTabBuilder() {
    Column() {
      Image(iconRes('download'))
        .width(22).height(22)
        .fillColor(this.currentMainTab === 0 ? this.tintColor : this.p.textSecondary)
      Text('下载')
        .fontSize(11)
        .margin({ top: 2 })
        .fontColor(this.currentMainTab === 0 ? this.tintColor : this.p.textSecondary)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  /** HdsTabs 设置 Tab（自定义，去掉系统矩形点击高亮） */
  @Builder
  meTabBuilder() {
    Column() {
      Image(iconRes('grid_dots'))
        .width(22).height(22)
        .fillColor(this.currentMainTab === 1 ? this.tintColor : this.p.textSecondary)
      Text('设置')
        .fontSize(11)
        .margin({ top: 2 })
        .fontColor(this.currentMainTab === 1 ? this.tintColor : this.p.textSecondary)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  /** HdsTabs 关于 Tab（第三个，排在更多之后） */
  @Builder
  aboutTabBuilder() {
    Column() {
      Image(iconRes('info'))
        .width(22).height(22)
        .fillColor(this.currentMainTab === 2 ? this.tintColor : this.p.textSecondary)
      Text('关于')
        .fontSize(11)
        .margin({ top: 2 })
        .fontColor(this.currentMainTab === 2 ? this.tintColor : this.p.textSecondary)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  /** HdsTabs 悬浮样式（参考项目 homeTabsFloatingStyle，毛玻璃悬浮导航条） */
  private tabsFloatingStyle(): HdsTabsFloatingStyle {
    // 材质跟随外观设置（appMaterialEffect 内部对 PC/大屏强制关闭，避免无拖拽时发白）
    const materialEffect: SystemMaterialParams = this.appMaterialEffect();
    // 导航条宽度：三个 Tab（下载/更多/关于），手机与平板固定 252，PC/2in1 取窗口宽度的 42%（上限 460，下限 252）
    const barW = this.is2in1 ? Math.min(460, Math.max(252, this.winWidth * 0.42)) : 252;
    // 居中显示（加3px修正HdsTabs系统偏移）
    const sideMargin = Math.max(16, (this.winWidth - barW) / 2 + 3);
    // 底部边距：手机/平板用系统导航指示条动态安全区高度；PC/2in1 自由窗口无导航指示条（高度为0），
    // 补 16vp 固定最小底边距，避免悬浮胶囊直接贴住窗口底边
    const naviH = AppStorage.get<number>('fluxdown_naviIndicatorHeight') ?? 0;
    const barBottom = this.is2in1 ? Math.max(naviH, 16) : naviH;
    const style: HdsTabsFloatingStyle = {
      // 实时从AppStorage读取动态底部安全区域高度（PC 兜底 16vp）
      barBottomMargin: barBottom,
      barSideMargin: sideMargin,
      barWidth: { smallWidth: barW, mediumWidth: barW, largeWidth: barW },
      lightColor: this.tintColor,
      systemMaterialEffect: materialEffect
    };
    return style;
  }

  /** miniBar 加号按钮（参考对比项目 AddFloatingButton：透明Button + clip(false)，背景来自miniBar毛玻璃） */
  @Builder
  AddMiniButton() {
    Stack({ alignContent: Alignment.Center }) {
      Button() {
        Image(iconRes('plus'))
          .width(24).height(24).fillColor(this.p.text)
      }
      .width(56).height(56)
      .backgroundColor(Color.Transparent)
      .onClick(() => {
        this.openAddSheet();
      })
    }
    .width(56).height(56)
    .clip(false)
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // 独立页面背景层（参考原项目 PageBackground，确保延伸到导航栏上下安全区域）
      Stack({ alignContent: Alignment.TopStart }) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(this.p.bg)
      }
      .width('100%')
      .height('100%')
      .position({ x: 0, y: 0 })
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
      .hitTestBehavior(HitTestMode.None)

      HdsNavigation(this.navPathStack) {
        if (this.pageReady) {
          Stack({ alignContent: Alignment.TopStart }) {
            // ── HdsTabs 主导航（参考项目：自带拖动收缩/展开 miniBar 交互，毛玻璃悬浮样式） ──
            HdsTabs({ controller: this.tabsController }) {
              TabContent() {
                Column() {
                  this.MasterView()
                }
                .width('100%')
                .height('100%')
                .backgroundColor(this.p.bg)
              }
              .tabBar(this.downloadTabBuilder())

              TabContent() {
                Column() {
                  SettingsContent({ vm: this.vm, navStack: this.navPathStack })
                }
                .width('100%')
                .height('100%')
                .backgroundColor(this.p.bg)
              }
              .tabBar(this.meTabBuilder())

              TabContent() {
                Column() {
                  AboutContent({
                    vm: this.vm,
                    onCheckUpdate: () => { this.checkForUpdate(false); },
                    onViewPrivacy: () => { this.showPrivacyPage = true; },
                    isCheckingUpdate: this.isCheckingUpdate,
                    checkUpdateStatus: this.checkUpdateStatus
                  })
                }
                .width('100%')
                .height('100%')
                .backgroundColor(this.p.bg)
              }
              .tabBar(this.aboutTabBuilder())
            }
            .barOverlap(true)
            .vertical(false)
            .scrollable(false)
            .barPosition(BarPosition.End)
            .barWidth(this.is2in1 ? Math.min(460, Math.max(252, this.winWidth * 0.42)) : 252)
            .barHeight(52)
            .barFloatingStyle(this.tabsFloatingStyle())
            .onChange((index: number) => {
              this.currentMainTab = index;
              if (index !== 0) {
                this.selectMode = false;
                this.selectedTaskIds = new Set();
              }
            })
            .width('100%')
            .height('100%')
          }
          .width('100%')
          .height('100%')
        } else {
          // 启动占位页（等 vm.init 完成后再渲染主界面，避免首次启动白屏）
          Column() {
            Image(iconRes('download'))
              .width(48).height(48)
              .fillColor(this.tintColor)
            Text('FluxDown Cover')
              .fontSize(16)
              .fontColor(this.p.textSecondary)
              .margin({ top: 12 })
          }
          .width('100%')
          .height('100%')
          .backgroundColor(this.p.bg)
          .justifyContent(FlexAlign.Center)
        }
      }
      .mode(NavigationMode.Stack)
      .titleBar({
        content: {
          title: {
            mainTitle: this.currentHomeTitle(),
            subTitle: this.currentMainTab === 0 ? this.titleSubtitle : ''
          },
          menu: this.homeSearchMenu()
        },
        style: {
          scrollEffectOpts: {
            enableScrollEffect: false,
            scrollEffectType: ScrollEffectType.GRADIENT_BLUR
          },
          blurStrategy: BlurStrategy.ADAPTIVE,
          // 手机端保持原全透明材质；仅 PC/大屏（宽>600）用轻半透明底色（材质在 appMaterialEffect 内对 PC 关闭）
          originalStyle: {
            backgroundStyle: {
              // 关于页用不透明底色，避免 logo 被透明毛玻璃糊住
              backgroundColor: this.currentMainTab === 2 ? this.p.bg : (this.is2in1 ? (this.p.dark ? '#1FFFFFFF' : '#14000000') : '#00ffffff')
            },
            // 标题/副标题跟随 App 主题；右上角菜单图标跟随「图标着色」（默认主题色，修复深色下跟系统发黑）
            contentStyle: {
              titleStyle: { mainTitleColor: this.p.text, subTitleColor: this.p.textSecondary },
              menuStyle: { iconColor: this.tintColor, textColor: this.tintColor }
            }
          },
          scrollEffectStyle: {
            backgroundStyle: {
              backgroundColor: this.currentMainTab === 2 ? this.p.bg : (this.is2in1 ? (this.p.dark ? '#1FFFFFFF' : '#14000000') : '#00ffffff')
            },
            contentStyle: {
              titleStyle: { mainTitleColor: this.p.text, subTitleColor: this.p.textSecondary },
              menuStyle: { iconColor: this.tintColor, textColor: this.tintColor }
            }
          },
          // 关于 tab 关闭毛玻璃材质 + 不透明底色，避免 logo 被模糊
          systemMaterialEffect: this.currentMainTab === 2
            ? { materialType: hdsMaterial.MaterialType.NONE, materialLevel: hdsMaterial.MaterialLevel.ADAPTIVE }
            : this.appMaterialEffect()
        },
        avoidLayoutSafeArea: true,
        enableComponentSafeArea: false
      })
      .navDestination(this.NavDest)
      .hideBackButton(true)
      .titleMode(HdsNavigationTitleMode.MINI)
      .ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.TOP, LayoutSafeAreaEdge.BOTTOM])
      .onAreaChange((_oldArea: Area, newArea: Area) => {
        const w = Math.round(newArea.width as number);
        if (Math.abs(w - this.winWidth) > 2) {
          this.winWidth = w;
        }
      })
      // ── 自定义新建下载弹窗（所有设备统一，不受缩放影响） ──
      if (this.showAddSheet) {
        Stack({ alignContent: this.winWidth < 600 ? Alignment.Center : Alignment.Center }) {
          Column()
            .width('100%')
            .height('100%')
            .backgroundColor('rgba(0,0,0,0.4)')
            .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
            .transition(TransitionEffect.OPACITY.animation({ duration: 200, curve: Curve.EaseInOut }))
          Column() {
            Row() {
              Blank()
              Stack({ alignContent: Alignment.Center }) {
                Column()
                  .width(32).height(32)
                  .borderRadius(16)
                  .backgroundColor(this.p.dark ? '#F23A3A3A' : '#F2F3F5')
                  .border({ width: 0.5, color: this.p.dark ? '#33FFFFFF' : '#1A000000' })
                Image(iconRes('x'))
                  .width(16).height(16).fillColor(this.p.text)
              }
              .onClick(() => { this.closeAddSheet(); })
            }
            .width('100%')
            .height(44)
            .padding({ left: 16, right: 12 })
            Scroll() {
              AddContent({ vm: this.vm, onDownloadStart: () => { this.closeAddSheet(); this.currentTab = 0; } })
            }
            .layoutWeight(1)
            .scrollBar(BarState.Off)
            .edgeEffect(EdgeEffect.Spring)
          }
          .width(this.winWidth < 600 ? '92%' : Math.min(720, this.winWidth * 0.88))
          .height(this.winWidth < 600 ? '82%' : '88%')
          // 折叠屏展开态物理高度封顶（vp），避免大屏按比例膨胀到折叠态的 1.2 倍以上（云测 UX 标准），内容区内部滚动
          .constraintSize({ maxHeight: 720 })
          .backgroundColor(this.p.surface)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(RADIUS_SHEET)
          .shadow(softShadow(this.p.dark, true))
          .padding({ bottom: 16 })
          .scale({ x: this.sheetScale, y: this.sheetScale, centerX: this.addSheetPivotX, centerY: this.addSheetPivotY })
          .opacity(this.sheetOpacity)
          .translate({ y: this.addSheetDragY })
          .animation({ duration: this.addSheetDragY === 0 ? 220 : 0, curve: Curve.Smooth })
          .gesture(
            PanGesture({ fingers: 1, direction: PanDirection.Vertical, distance: 5 })
              .onActionUpdate((event: GestureEvent) => {
                this.addSheetDragY = event.offsetY;
              })
              .onActionEnd((event: GestureEvent) => {
                if (event.offsetY > 120) {
                  this.closeAddSheet();
                }
                this.addSheetDragY = 0;
              })
              .onActionCancel(() => {
                this.addSheetDragY = 0;
              })
          )
          .onAreaChange((_oldArea: Area, newArea: Area) => {
            // 记录弹窗左上角的窗口坐标，用于把缩放锚点对齐到右下角加号
            this.addSheetOriginX = newArea.globalPosition.x as number;
            this.addSheetOriginY = newArea.globalPosition.y as number;
          })
        }
        .width('100%')
        .height('100%')
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
      }
      // ── 自定义筛选弹窗 ──
      if (this.showFilterSheet) {
        Stack({ alignContent: Alignment.Center }) {
          Column()
            .width('100%')
            .height('100%')
            .backgroundColor('rgba(0,0,0,0.4)')
            .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
            .opacity(this.filterSheetOpacity)
            .onClick(() => { this.closeFilterSheet(); })
          Column() {
            Row() {
              Text('筛选与排序')
                .fontSize(17).fontWeight(FontWeight.Bold).fontColor(this.p.text)
                .layoutWeight(1)
              Stack({ alignContent: Alignment.Center }) {
                Column()
                  .width(32).height(32)
                  .borderRadius(16)
                  .backgroundColor(this.p.dark ? '#F23A3A3A' : '#F2F3F5')
                  .border({ width: 0.5, color: this.p.dark ? '#33FFFFFF' : '#1A000000' })
                Image(iconRes('x'))
                  .width(16).height(16).fillColor(this.p.text)
              }
              .onClick(() => { this.closeFilterSheet(); })
            }
            .width('100%').padding({ left: 20, right: 16, top: 16, bottom: 12 })
            Scroll() {
              Column() {
                Text('分类').fontSize(13).fontColor(this.p.textSecondary)
                  .width('100%').padding({ left: 20, bottom: 6 })
                Flex({ wrap: FlexWrap.Wrap }) {
                  FilterChipComponent({ label: '全部', selected: this.vm.filterCategory.length === 0, p: this.p, onTap: () => { this.vm.setCategoryFilter(''); } })
                  ForEach(BUILTIN_CATEGORIES, (cat: BuiltinCategory) => {
                    FilterChipComponent({ label: cat.name, selected: this.vm.filterCategory === cat.id, p: this.p, onTap: () => { this.vm.setCategoryFilter(cat.id); } })
                  }, (cat: BuiltinCategory) => cat.id)
                  ForEach(this.vm.categories, (cat: DownloadCategory) => {
                    FilterChipComponent({ label: cat.name, selected: this.vm.filterCategory === cat.id, p: this.p, onTap: () => { this.vm.setCategoryFilter(cat.id); } })
                  }, (cat: DownloadCategory) => cat.id)
                }
                .width('100%').padding({ left: 16, right: 16, bottom: 16 })
                Text('队列').fontSize(13).fontColor(this.p.textSecondary)
                  .width('100%').padding({ left: 20, bottom: 6 })
                Flex({ wrap: FlexWrap.Wrap }) {
                  FilterChipComponent({ label: '全部队列', selected: this.vm.queueFilter.length === 0, p: this.p, onTap: () => { this.vm.setQueueFilter(''); } })
                  ForEach(this.vm.queues, (q: DownloadQueue) => {
                    FilterChipComponent({ label: q.name, selected: this.vm.queueFilter === q.id, p: this.p, onTap: () => { this.vm.setQueueFilter(q.id); } })
                  }, (q: DownloadQueue) => q.id)
                }
                .width('100%').padding({ left: 16, right: 16, bottom: 16 })
                Text('排序').fontSize(13).fontColor(this.p.textSecondary)
                  .width('100%').padding({ left: 20, bottom: 6 })
                Column() {
                  this.SortRow('最新创建', 'time')
                  this.SortRow('按大小', 'size')
                  this.SortRow('按名称', 'name')
                  this.SortRow('按优先级', 'priority')
                }
                .width('100%').padding({ left: 16, right: 16, bottom: 20 })
              }
              .width('100%')
            }
            .layoutWeight(1)
            .scrollBar(BarState.Off)
          }
          .width(this.winWidth < 600 ? '88%' : Math.min(480, this.winWidth * 0.7))
          .height(this.winWidth < 600 ? '72%' : '70%')
          // 与新建下载弹窗一致：折叠屏展开态物理高度封顶，避免大屏膨胀（云测 UX 标准）
          .constraintSize({ maxHeight: 620 })
          .backgroundColor(this.p.materialBg)
          .backgroundBlurStyle(MATERIAL_BLUR)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(RADIUS_SHEET)
          .clip(true)
          .scale({ x: this.filterSheetScale, y: this.filterSheetScale, centerX: '50%', centerY: '50%' })
          .opacity(this.filterSheetOpacity)
        }
        .width('100%')
        .height('100%')
      }

      // 首启隐私政策同意弹窗（未同意前覆盖主界面）
      if (this.showPrivacyDialog) {
        this.PrivacyDialog()
      }
      // 隐私政策全文页
      if (this.showPrivacyPage) {
        this.PrivacyFullPage()
      }
    }
    .width('100%')
    .height('100%')
  }

  /** 首启隐私政策弹窗 */
  @Builder
  PrivacyDialog() {
    Column() {
      Column() {
        Text(PRIVACY_APP_NAME + ' 隐私政策')
          .fontSize(18).fontWeight(FontWeight.Medium).fontColor(this.p.text)
          .margin({ bottom: 14, top: 4 })
        Scroll() {
          Text(PRIVACY_SUMMARY + '\n\n点击“同意并继续”表示您已阅读并同意《' + PRIVACY_APP_NAME + '隐私政策》，您可点击下方文字查看完整内容。')
            .fontSize(14).fontColor(this.p.textSecondary).lineHeight(22).width('100%')
        }
        .layoutWeight(1).width('100%').scrollBar(BarState.Auto)

        Text('查看完整《隐私政策》')
          .fontSize(13).fontColor(this.p.primary).margin({ top: 10, bottom: 12 })
          .onClick(() => { this.showPrivacyPage = true; })

        Row() {
          Button('不同意')
            .layoutWeight(1).height(42)
            .backgroundColor(this.p.surface).fontColor(this.p.textSecondary)
            .borderRadius(10).margin({ right: 8 })
            .onClick(() => { this.refusePrivacy(); })
          Button('同意并继续')
            .layoutWeight(1).height(42)
            .backgroundColor(this.p.primarySolid).fontColor(Color.White)
            .borderRadius(10).margin({ left: 8 })
            .onClick(() => { this.agreePrivacy(); })
        }.width('100%')
      }
      .width('86%').constraintSize({ maxHeight: '70%' })
      .padding(20)
      .backgroundColor(this.p.bg)
      .borderRadius(18)
    }
    .width('100%').height('100%')
    .backgroundColor('rgba(0,0,0,0.55)')
    .justifyContent(FlexAlign.Center)
  }

  /** 隐私政策全文页 */
  @Builder
  PrivacyFullPage() {
    Column() {
      // 顶部导航（返回按钮与系统子页统一：左箭头图标，而非文字）
      Row() {
        Row() {
          Image(iconRes('chevron_right'))
            .width(26).height(26)
            .fillColor(this.p.text)
            .rotate({ angle: 180 })
        }
        .width(42).height(42)
        .justifyContent(FlexAlign.Center)
        .onClick(() => { this.showPrivacyPage = false; })

        Text('隐私政策').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text)
          .layoutWeight(1).textAlign(TextAlign.Center)

        // 右侧等宽占位，保证标题真正居中
        Row().width(42).height(42)
      }
      .width('100%')
      .padding({
        left: 8,
        right: 8,
        top: (AppStorage.get<number>('fluxdown_statusBarHeight') ?? 0) + 8,
        bottom: 8
      })

      Scroll() {
        Column() {
          Text(PRIVACY_APP_NAME + ' 隐私政策')
            .fontSize(19).fontWeight(FontWeight.Bold).fontColor(this.p.text).width('100%').margin({ bottom: 6 })
          Text('更新日期：' + PRIVACY_UPDATE_DATE + '    联系邮箱：' + PRIVACY_CONTACT_EMAIL)
            .fontSize(12).fontColor(this.p.textSecondary).width('100%').margin({ bottom: 14 })
          Text(PRIVACY_SUMMARY).fontSize(14).fontColor(this.p.text).lineHeight(23).width('100%').margin({ bottom: 12 })
          ForEach(PRIVACY_SECTIONS, (sec: PrivacySection) => {
            Text(sec.title).fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.p.text)
              .width('100%').margin({ top: 10, bottom: 6 })
            Text(sec.body).fontSize(14).fontColor(this.p.textSecondary).lineHeight(23).width('100%')
          }, (sec: PrivacySection) => sec.title)
          Text('').height(24)
        }.width('100%').padding({ left: 18, right: 18 })
      }
      .layoutWeight(1).width('100%').scrollBar(BarState.Auto).align(Alignment.Top)

      if (this.showPrivacyDialog) {
        Button('已阅读并同意').width('90%').height(44)
          .backgroundColor(this.p.primarySolid).fontColor(Color.White).borderRadius(10)
          .margin({ bottom: 18 })
          .onClick(() => { this.showPrivacyPage = false; })
      }
    }
    .width('100%').height('100%').backgroundColor(this.p.bg)
  }

  /** Responsive content width for nav destinations: full width on narrow windows,
   *  capped + centered on large windows to avoid overly long lines. */
  @Computed
  get contentWidth(): string {
    // 内容区始终 100% 自适应，随窗口拉伸无白边
    return '100%';
  }

  /** Responsive nav bar width: 360 on wide windows, narrows as window shrinks (min 320). */
  @Computed
  get navBarWidthValue(): number {
    if (this.winWidth <= 0) {
      return 360;
    }
    if (this.winWidth > 1000) {
      return 360;
    }
    if (this.winWidth > 700) {
      return Math.max(320, Math.round(this.winWidth * 0.36));
    }
    return 320;
  }

  @Builder
  NavDest(name: string, param: Object) {
    if (name === 'detail') {
      NavDestination() {
        Stack({ alignContent: this.winWidth < 600 ? Alignment.Center : Alignment.Center }) {
          Column() {
            Column() {
              this.SubPageHeader('任务详情', 'chevron_left')
              TaskDetailContent({ task: param as DownloadTask, vm: this.vm })
            }
            .width('100%')
            .animation({ duration: 200, curve: Curve.EaseOut })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Center)
          .transition(TransitionEffect.translate({ x: 40 }).combine(TransitionEffect.OPACITY).animation({ duration: 250, curve: Curve.EaseOut }))
          if (this.centerToast.length > 0) {
            this.CenterToast()
          }
        }
        .width('100%')
        .height('100%')
        .backgroundColor(this.p.bg)
      }
      .hideTitleBar(true)
      .mode(NavDestinationMode.STANDARD)
      .backgroundColor(this.p.bg)
    } else if (name === 'add') {
      NavDestination() {
        Stack({ alignContent: this.winWidth < 600 ? Alignment.Center : Alignment.Center }) {
          Column() {
            Column() {
              this.SubPageHeader('新建下载', 'x')
              AddContent({ vm: this.vm, navStack: this.navPathStack, onDownloadStart: () => { this.currentTab = 0; this.navPathStack.pop(); } })
            }
            .width('100%')
            .animation({ duration: 200, curve: Curve.EaseOut })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Center)
          .transition(TransitionEffect.translate({ x: 40 }).combine(TransitionEffect.OPACITY).animation({ duration: 250, curve: Curve.EaseOut }))
          if (this.centerToast.length > 0) {
            this.CenterToast()
          }
        }
        .width('100%')
        .height('100%')
        .backgroundColor(this.p.bg)
      }
      .hideTitleBar(true)
      .mode(NavDestinationMode.STANDARD)
      .backgroundColor(this.p.bg)
    } else if (name === 'about') {
      NavDestination() {
        Stack({ alignContent: this.winWidth < 600 ? Alignment.Center : Alignment.Center }) {
          Column() {
            Column() {
              this.SubPageHeader('关于', 'chevron_left')
              AboutContent({
                vm: this.vm,
                onCheckUpdate: () => { this.checkForUpdate(false); },
                onViewPrivacy: () => { this.showPrivacyPage = true; }
              })
            }
            .width('100%')
            .animation({ duration: 200, curve: Curve.EaseOut })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Center)
          .transition(TransitionEffect.translate({ x: 40 }).combine(TransitionEffect.OPACITY).animation({ duration: 250, curve: Curve.EaseOut }))
          if (this.centerToast.length > 0) {
            this.CenterToast()
          }
        }
        .width('100%')
        .height('100%')
        .backgroundColor(this.p.bg)
      }
      .hideTitleBar(true)
      .mode(NavDestinationMode.STANDARD)
      .backgroundColor(this.p.bg)
    } else if (name === 'stats') {
      NavDestination() {
        Stack({ alignContent: this.winWidth < 600 ? Alignment.Center : Alignment.Center }) {
          Column() {
            Column() {
              this.SubPageHeader('下载统计', 'chevron_left')
              StatsContent({ vm: this.vm })
            }
            .width('100%')
            .animation({ duration: 200, curve: Curve.EaseOut })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Center)
          .transition(TransitionEffect.translate({ x: 40 }).combine(TransitionEffect.OPACITY).animation({ duration: 250, curve: Curve.EaseOut }))
          if (this.centerToast.length > 0) {
            this.CenterToast()
          }
        }
        .width('100%')
        .height('100%')
        .backgroundColor(this.p.bg)
      }
      .hideTitleBar(true)
      .mode(NavDestinationMode.STANDARD)
      .backgroundColor(this.p.bg)
    } else if (name === 'setting') {
      NavDestination() {
        Stack({ alignContent: this.winWidth < 600 ? Alignment.Center : Alignment.Center }) {
          Column() {
            Column() {
              this.SubPageHeader(this.settingPageTitle(param as string), 'chevron_left')
              SettingsContent({ vm: this.vm, navStack: this.navPathStack, mode: param as string })
            }
            .width('100%')
            .animation({ duration: 200, curve: Curve.EaseOut })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Center)
          .transition(TransitionEffect.translate({ x: 40 }).combine(TransitionEffect.OPACITY).animation({ duration: 250, curve: Curve.EaseOut }))
          if (this.centerToast.length > 0) {
            this.CenterToast()
          }
        }
        .width('100%')
        .height('100%')
        .backgroundColor(this.p.bg)
      }
      .hideTitleBar(true)
      .mode(NavDestinationMode.STANDARD)
      .backgroundColor(this.p.bg)
    }
  }

  /** 设置子页标题映射 */
  private settingPageTitle(mode: string): string {
    const map: Record<string, string> = {
      'appearance': '外观', 'download': '下载设置', 'bt': 'BT 下载',
      'mcp': 'MCP 服务', 'ext': '浏览器扩展', 'queue': '下载队列',
      'cat': '自定义分类', 'rss': 'RSS 订阅', 'huawei_account': '华为账号'
    };
    return map[mode] ?? '设置';
  }

  @Builder
  CenterToast() {
    Text(this.centerToast)
      .fontSize(14)
      .fontColor('#FFFFFF')
      .backgroundColor('#E63A3D45')
      .borderRadius(20)
      .padding({ left: 22, right: 22, top: 11, bottom: 11 })
      .shadow(softShadow(this.p.dark))
      .animation({ duration: 160, curve: Curve.EaseOut })
  }

  @Builder
  AddSheetBuilder() {
    AddContent({ vm: this.vm, onDownloadStart: () => { this.showAddSheet = false; this.currentTab = 0; } })
  }

  @Builder
  SortRow(label: string, key: string) {
    Row() {
      Text(label).fontSize(14).fontColor(this.p.text).layoutWeight(1)
      if (this.vm.sortBy === key) {
        Image(iconRes('check')).width(18).height(18).fillColor(this.tintColor)
      }
    }
    .width('100%').padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .backgroundColor(this.vm.sortBy === key ? this.p.surfaceHighlight : this.p.surface)
    .borderRadius(10)
    .margin({ bottom: 8 })
    .onClick(() => { this.vm.setSortBy(key); })
  }

  @Builder
  MasterView() {
    Stack({ alignContent: Alignment.BottomEnd }) {
      Column() {
      // ── 顶部头部：避让悬浮标题栏（状态栏+标题栏高），常驻搜索栏 + 选择/状态Tab ──
      Column() {
        // 常驻搜索栏（对齐参考项目 HomeSearchBar：ImmersionSearch 一直显示在顶部）
        ImmersionSearch({
          systemMaterialEffect: this.appMaterialEffect(),
          _height: 40,
          options: { placeholder: '搜索下载任务' },
          modifier: new HomeSearchModifier(
            this.p.text,
            this.p.textSecondary,
            (value: string): void => {
              this.vm.setSearchQuery(value);
            }
          )
        })
          .height(40)
          .width('100%')
          .margin({ bottom: 8 })
          .clip(false)

        // ── 选择按钮（状态Tab上方靠右）+ 状态 Tabs（固定居中显示，不滚动） ──
        Column() {
        if (this.vm.visibleTasks.length > 0) {
          Row() {
            Blank()
            Text(this.selectMode ? '取消' : '选择')
              .fontSize(14)
              .fontColor(this.p.primary)
              .padding({ left: 12, right: 12, top: 4, bottom: 4 })
              .borderRadius(8)
              .onClick(() => {
                this.selectMode = !this.selectMode;
                if (!this.selectMode) {
                  this.selectedTaskIds = new Set();
                }
              })
          }
          .width('100%')
          .padding({ right: 12, bottom: 4 })
        }

        Row() {
          Row() {
            this.StatusTab('全部', '')
            this.StatusTab('下载中', 'downloading')
            this.StatusTab('已完成', 'completed')
            this.StatusTab('做种', 'seeding')
            this.StatusTab('已暂停', 'paused')
            this.StatusTab('错误', 'error')
          }
          .layoutWeight(1)
        }
        .width('100%')
        }
        .width('100%')
      }
      .width('100%')
      .padding({
        left: this.is2in1 ? 16 : 12,
        right: this.is2in1 ? 16 : 12,
        top: this.statusBarHeight + 56 + 10,
        bottom: 4
      })

      if (this.vm.visibleTasks.length === 0) {
        Column({ space: 18 }) {
          Image(iconRes('download'))
            .width(88).height(88).fillColor(this.tintColor)
            .opacity(0.9)
          Text('还没有下载任务')
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.p.text)
          if (this.is2in1) {
            // PC/2in1：ImmersionButton 系统材质在 PC 上会回退成发白底，改用原生毛玻璃胶囊
            // （与右下角 FAB、右上角按钮同一范式），深/浅色都呈现与手机、平板一致的可见胶囊背景，
            // 不再全透明只剩文字（修复 PC 深色下“新建下载”按钮背景丢失、与平板手机不一致）
            Button('新建下载')
              .width(148)
              .height(44)
              .type(ButtonType.Capsule)
              .backgroundColor(withAlpha(this.p.surface, 0.72))
              .backgroundBlurStyle(MATERIAL_BLUR)
              .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
              .shadow(softShadow(this.p.dark))
              .fontColor(this.p.text)
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .clip(false)
              .onClick(() => { this.openAddSheet(); })
          } else {
            // 手机端：保持原 ImmersionButton（沉浸光感动效 + 透明材质 + 适配文字色），不改动手机观感
            ImmersionButton({
              systemMaterialEffect: this.appMaterialEffect(),
              text: '新建下载',
              buttonModify: new ImmersionButtonModifier(148, 44, this.p.dark ? '#FFFFFF' : '#000000'),
              click: (): void => {
                this.openAddSheet();
              }
            })
            .width(148)
            .height(44)
          }
        }
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .transition(TransitionEffect.OPACITY.animation({ duration: 300, curve: Curve.EaseInOut }))
      } else {
        Stack({ alignContent: Alignment.BottomEnd }) {
          List() {
            ForEach(this.vm.visibleTasks, (task: DownloadTask) => {
              ListItem() {
                this.TaskRow(task)
              }
              .onClick(() => {
                if (this.selectMode) {
                  const s = new Set(this.selectedTaskIds);
                  if (s.has(task.id)) {
                    s.delete(task.id);
                  } else {
                    s.add(task.id);
                  }
                  this.selectedTaskIds = s;
                } else {
                  this.navPathStack.pushPath({ name: 'detail', param: task });
                }
              })
              .onMouse((event: MouseEvent) => {
                if (event.button === MouseButton.Right) {
                  this.contextMenuTask = task;
                }
              })
              .bindContextMenu(this.selectMode ? undefined : this.RightClickMenu, ResponseType.RightClick)
              .swipeAction(this.selectMode ? undefined : {
                end: {
                  builder: () => {
                    this.SwipeActionForTask(task);
                  },
                  actionAreaDistance: 56
                }
              })
              .transition(TransitionEffect.translate({ y: 20 }).combine(TransitionEffect.OPACITY)
                .animation({ duration: 250, curve: Curve.Smooth }))
            }, (task: DownloadTask) => task.id)
          }
          .width('100%')
          .height('100%')
          .divider({ strokeWidth: 1, color: this.p.border })
          .contentEndOffset(this.naviIndicatorHeight + 52 + 10)
          .transition(TransitionEffect.OPACITY.animation({ duration: 250, curve: Curve.Smooth }))
          .animation({ duration: 200, curve: Curve.Smooth })
          .edgeEffect(EdgeEffect.Spring)
        }
        .layoutWeight(1)
        .width('100%')
      }

      // ── 选择模式底部操作栏（毛玻璃胶囊，导航栏上方） ──
      if (this.selectMode) {
        Row() {
          Text(`已选 ${this.selectedTaskIds.size} 项`)
            .fontSize(13)
            .fontColor(this.p.text)
            .margin({ right: 12 })
          Button(this.selectedTaskIds.size === this.vm.visibleTasks.length ? '取消全选' : '全选')
            .type(ButtonType.Capsule)
            .fontSize(13)
            .backgroundColor(Color.Transparent)
            .backgroundBlurStyle(MATERIAL_BLUR)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .fontColor(this.p.primary)
            .height(32)
            .margin({ right: 8 })
            .clip(false)
            .onClick(() => {
              if (this.selectedTaskIds.size === this.vm.visibleTasks.length) {
                this.selectedTaskIds = new Set();
              } else {
                this.selectedTaskIds = new Set(this.vm.visibleTasks.map(t => t.id));
              }
            })
          Button(`删除${this.selectedTaskIds.size > 0 ? `(${this.selectedTaskIds.size})` : ''}`)
            .type(ButtonType.Capsule)
            .fontSize(13)
            .backgroundColor(this.selectedTaskIds.size > 0 ? '#DB371A' : Color.Transparent)
            .backgroundBlurStyle(this.selectedTaskIds.size > 0 ? BlurStyle.COMPONENT_THIN : MATERIAL_BLUR)
            .border({ width: MATERIAL_BORDER_WIDTH, color: this.selectedTaskIds.size > 0 ? '#80E8553B' : materialBorder(this.p.dark) })
            .fontColor(this.selectedTaskIds.size > 0 ? '#FFFFFF' : this.p.textSecondary)
            .enabled(this.selectedTaskIds.size > 0)
            .height(32)
            .clip(false)
            .onClick(() => {
              if (this.selectedTaskIds.size === 0) {
                return;
              }
              const tasks = this.vm.visibleTasks.filter(t => this.selectedTaskIds.has(t.id));
              this.showDeleteDialog(tasks, true);
            })
        }
        .padding({ left: 16, right: 16, top: 8, bottom: 8 })
        .backgroundColor(this.p.materialBg)
        .backgroundBlurStyle(MATERIAL_BLUR)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(24)
        .shadow(softShadow(this.p.dark))
        .margin({ bottom: this.naviIndicatorHeight + 64 })
        .alignSelf(ItemAlign.Center)
      }

      // ── FAB 新建下载（右下角，参考对比项目FAB：透明Button + 系统毛玻璃 + clip(false)） ──
      if (!this.selectMode) {
      Stack({ alignContent: Alignment.Center }) {
        Button() {
          Image(iconRes('plus'))
            .width(24).height(24).fillColor(this.p.dark ? '#FFFFFFFF' : '#FF000000')
        }
        .width(56).height(56)
        .backgroundColor(Color.Transparent)
        .onClick(() => { this.openAddSheet(); })
      }
      .width(56).height(56)
      .borderRadius(28)
      .backgroundColor(this.p.dark ? '#1FFFFFFF' : '#14000000')
      .backgroundBlurStyle(MATERIAL_BLUR)
      .shadow(softShadow(this.p.dark, true))
      .margin({ right: 20, bottom: this.naviIndicatorHeight + 64 })
      .alignSelf(ItemAlign.End)
      .clip(false)
      }

      // ── 重命名 / 移动对话框（覆盖层） ──
      if (this.renameDialogVisible) {
        this.InlineDialog(
          '重命名',
          this.renameDraft,
          '输入新文件名',
          (v: string) => { this.renameDraft = v; },
          () => { this.renameDialogVisible = false; },
          () => { this.confirmRename(); }
        )
      }
      if (this.moveDialogVisible) {
        this.InlineDialog(
          '移动到目录',
          this.moveDraft,
          '输入目标目录绝对路径',
          (v: string) => { this.moveDraft = v; },
          () => { this.moveDialogVisible = false; },
          () => { this.confirmMove(); }
        )
      }
      }
      .width('100%')
      .height('100%')

    }
    .width('100%')
    .height('100%')
  }

  @Builder
  InlineDialog(title: string, draft: string, placeholder: string,
    onChange: (v: string) => void, onCancel: () => void, onOk: () => void) {
    Column() {
      Blank()
      Column() {
        Text(title).fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        TextInput({ text: draft, placeholder: placeholder }).caretColor(this.p.primary)
          .fontSize(14)
          .fontColor(this.p.text)
          .placeholderColor(this.p.textSecondary)
          .backgroundColor(this.p.surfaceHighlight)
          .borderRadius(8)
          .width('100%')
          .margin({ top: 16 })
          .onChange(onChange)
        Row() {
          Button('取消')
            .type(ButtonType.Capsule)
            .fontSize(14)
            .backgroundColor(this.p.surfaceSolid)
            .fontColor(this.p.textSecondary)
            .layoutWeight(1)
            .margin({ right: 8 })
            .onClick(onCancel)
          Button('确定')
            .type(ButtonType.Capsule)
            .fontSize(14)
            .backgroundColor(this.p.primarySolid)
            .fontColor(this.p.onPrimary)
            .layoutWeight(1)
            .margin({ left: 8 })
            .onClick(onOk)
        }
        .width('100%')
        .margin({ top: 16 })
      }
      .padding(20)
      .width('86%')
      .backgroundColor(this.p.materialBg)
      .backgroundBlurStyle(MATERIAL_BLUR)
      .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
      .borderRadius(RADIUS_SHEET)
      .shadow(softShadow(this.p.dark, true))
      Blank()
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#66000000')
    .position({ x: 0, y: 0 })
  }

  @Builder
  TabButton(label: string, index: number, icon: string) {
    Row() {
      Image(iconRes(icon))
        .width(16).height(16)
        .fillColor(this.currentTab === index ? this.p.onPrimary : this.p.text)
      Text(label)
        .fontSize(14)
        .fontColor(this.currentTab === index ? this.p.onPrimary : this.p.text)
        .margin({ left: 6 })
    }
    .layoutWeight(1)
    .height(40)
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.currentTab === index ? this.p.primarySolid : this.p.surface)
    .borderRadius(10)
    .margin({ left: 4, right: 4 })
    .animation({ duration: 250, curve: Curve.EaseInOut })
    .onClick(() => {
      this.currentTab = index;
      this.selectMode = false;
      this.selectedTaskIds = new Set();
      if (index === 0) {
        this.vm.setStatusFilter('');
      } else if (index === 1) {
        this.vm.setStatusFilter('active');
      } else {
        this.vm.setStatusFilter('completed');
      }
    })
  }

  @Builder
  StatusChip(label: string, key: string) {
    Text(label)
      .fontSize(11)
      .fontColor(this.vm.statusFilter === key ? this.p.onPrimary : this.p.textSecondary)
      .padding({ left: 10, right: 10, top: 5, bottom: 5 })
      .borderRadius(12)
      .backgroundColor(this.vm.statusFilter === key ? this.p.primarySolid : this.p.surface)
      .margin({ right: 6 })
      .onClick(() => {
        this.vm.setStatusFilter(key);
        if (key !== '') {
          this.currentTab = -1;
        } else if (this.currentTab === -1) {
          this.currentTab = 0;
        }
      })
  }

  @Builder
  StatusTab(label: string, key: string) {
    Stack({ alignContent: Alignment.Center }) {
      Text(`${label} ${this.countForStatus(key)}`)
        .fontSize(this.is2in1 ? 13 : (this.winWidth < 360 ? 11 : 12))
        .fontWeight(this.vm.statusFilter === key ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.vm.statusFilter === key ? this.p.primary : this.p.textSecondary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .padding({ left: this.is2in1 ? 8 : 4, right: this.is2in1 ? 8 : 4 })
    }
    .height(this.is2in1 ? 38 : 32)
    .borderRadius(this.is2in1 ? 19 : 16)
    .backgroundColor(Color.Transparent)
    .backgroundBlurStyle(MATERIAL_BLUR)
    .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
    .layoutWeight(1)
    .margin({ right: this.is2in1 ? 10 : 4 })
    .clip(false)
    .onClick(() => {
      this.vm.setStatusFilter(key);
      this.currentTab = key === '' ? 0 : -1;
      this.selectMode = false;
      this.selectedTaskIds = new Set();
    })
  }

  private countForStatus(key: string): number {
    if (key === '') {
      return this.vm.tasks.length;
    }
    if (key === 'downloading') {
      return this.vm.tasks.filter((t: DownloadTask) => t.status === TaskStatus.Downloading || t.status === TaskStatus.Merging || t.status === TaskStatus.Verifying || t.status === TaskStatus.Queued).length;
    }
    if (key === 'completed') {
      return this.vm.tasks.filter((t: DownloadTask) => t.status === TaskStatus.Completed).length;
    }
    if (key === 'seeding') {
      return this.vm.tasks.filter((t: DownloadTask) => t.seedingStatus !== 'none' && t.seedingStatus !== undefined && t.seedingStatus !== null).length;
    }
    if (key === 'paused') {
      return this.vm.tasks.filter((t: DownloadTask) => t.status === TaskStatus.Paused).length;
    }
    if (key === 'error') {
      return this.vm.tasks.filter((t: DownloadTask) => t.status === TaskStatus.Error).length;
    }
    return 0;
  }

  @Builder
  RightClickMenu() {
    Menu() {
      if (this.contextMenuTask) {
        if (this.contextMenuTask.status === TaskStatus.Completed) {
          MenuItem({ content: '打开文件' })
            .onChange(() => {
              this.openFile(this.contextMenuTask!);
            })
          MenuItem({ content: '打开文件所在目录' })
            .onChange(() => {
              this.openFileLocation(this.contextMenuTask!);
            })
        }
        if (this.contextMenuTask.status === TaskStatus.Downloading || this.contextMenuTask.status === TaskStatus.Queued) {
          MenuItem({ content: '暂停' })
            .onChange(() => {
              this.vm.pause(this.contextMenuTask!);
            })
        } else if (this.contextMenuTask.status === TaskStatus.Paused || this.contextMenuTask.status === TaskStatus.Error) {
          MenuItem({ content: '继续下载' })
            .onChange(() => {
              this.vm.resume(this.contextMenuTask!);
            })
        }
        if (this.contextMenuTask.status !== TaskStatus.Downloading && this.contextMenuTask.status !== TaskStatus.Verifying) {
          MenuItem({ content: '重命名' })
            .onChange(() => {
              this.showRenameDialog(this.contextMenuTask!);
            })
          MenuItem({ content: '移动到目录…' })
            .onChange(() => {
              this.showMoveDialog(this.contextMenuTask!);
            })
        }
        if (this.contextMenuTask.status === TaskStatus.Error || this.contextMenuTask.status === TaskStatus.Paused) {
          MenuItem({ content: '重新检查' })
            .onChange(() => {
              this.vm.recheckTask(this.contextMenuTask!).then(() => {
                safeToast(this.getUIContext(), '已重新检查，可从下载列表重新开始' );
              }).catch((e: Error) => {
                safeToast(this.getUIContext(), '重新检查失败: ' + (e?.message || String(e)) );
              });
            })
        }
        if (this.contextMenuTask.protocol === ProtocolType.BITTORRENT) {
          MenuItem({ content: this.contextMenuTask.seedingStatus === 'none' ? '开始做种' : '停止做种' })
            .onChange(() => {
              const t = this.contextMenuTask;
              if (t) {
                if (t.seedingStatus === 'none') {
                  this.vm.startSeeding(t);
                } else {
                  this.vm.stopSeeding(t);
                }
              }
            })
        }
        MenuItem({ content: '删除' })
          .onChange(() => {
            this.showDeleteDialog([this.contextMenuTask!], false);
          })
      }
    }
  }

  /** 删除确认对话框：可选择是否保留文件。 */
  private showDeleteDialog(tasks: DownloadTask[], isBatch: boolean): void {
    this.getUIContext().showAlertDialog(
      {
        title: isBatch ? '批量删除' : '删除任务',
        message: isBatch
          ? `确定要删除选中的 ${tasks.length} 个下载任务吗？`
          : '确定要删除此下载任务吗？',
        autoCancel: true,
        alignment: DialogAlignment.Center,
        buttons: [
          {
            value: '取消',
            action: () => {},
            fontColor: this.p.textSecondary
          },
          {
            value: '仅删除任务',
            action: () => {
              if (isBatch) {
                this.vm.removeTasks(tasks.map(t => t.id), true);
                this.selectedTaskIds = new Set();
                this.selectMode = false;
              } else {
                this.vm.remove(tasks[0], true);
              }
            },
            fontColor: this.p.primary
          },
          {
            value: '删除并删除文件',
            action: () => {
              if (isBatch) {
                this.vm.removeTasks(tasks.map(t => t.id), false);
                this.selectedTaskIds = new Set();
                this.selectMode = false;
              } else {
                this.vm.remove(tasks[0], false);
              }
            },
            fontColor: this.p.error
          }
        ]
      }
    );
  }

  /** 重命名对话框。 */
  private showRenameDialog(task: DownloadTask): void {
    this.renameTarget = task;
    this.renameDraft = task.fileName;
    this.renameDialogVisible = true;
  }

  /** 移动目录对话框。 */
  private showMoveDialog(task: DownloadTask): void {
    this.moveTarget = task;
    this.moveDraft = task.dirPath;
    this.moveDialogVisible = true;
  }

  private confirmRename(): void {
    const t = this.renameTarget;
    const name = this.renameDraft.trim();
    if (!t || name.length === 0) {
      this.renameDialogVisible = false;
      return;
    }
    this.vm.renameTask(t, name).then(() => {
      safeToast(this.getUIContext(), '已重命名' );
      this.renameDialogVisible = false;
    }).catch((e: Error) => {
      safeToast(this.getUIContext(), '重命名失败: ' + (e?.message || String(e)) );
    });
  }

  private confirmMove(): void {
    const t = this.moveTarget;
    const dir = this.moveDraft.trim();
    if (!t || dir.length === 0) {
      this.moveDialogVisible = false;
      return;
    }
    this.vm.moveTask(t, dir).then(() => {
      safeToast(this.getUIContext(), '已移动任务' );
      this.moveDialogVisible = false;
    }).catch((e: Error) => {
      safeToast(this.getUIContext(), '移动失败: ' + (e?.message || String(e)) );
    });
  }

  @Builder
  SwipeActionForTask(task: DownloadTask) {
    Row() {
      if (task.status === TaskStatus.Downloading) {
        Button() {
          Row() {
            Image(iconRes('pause')).width(14).height(14).fillColor('#FFFFFF')
            Text('暂停').fontSize(13).fontColor('#FFFFFF').margin({ left: 3 })
          }
          .justifyContent(FlexAlign.Center)
        }
        .type(ButtonType.Capsule)
        .backgroundColor('#B06100')
        .width(64)
        .height(40)
        .margin({ right: 6 })
        .onClick(() => {
          this.vm.pause(task);
        })
      } else if (task.status === TaskStatus.Paused || task.status === TaskStatus.Error) {
        Button() {
          Row() {
            Image(iconRes('play')).width(14).height(14).fillColor('#FFFFFF')
            Text('继续').fontSize(13).fontColor('#FFFFFF').margin({ left: 3 })
          }
          .justifyContent(FlexAlign.Center)
        }
        .type(ButtonType.Capsule)
        .backgroundColor('#388512')
        .width(64)
        .height(40)
        .margin({ right: 6 })
        .onClick(() => {
          this.vm.resume(task);
        })
      } else if (task.status === TaskStatus.Completed) {
        Button() {
          Row() {
            Image(iconRes('open')).width(14).height(14).fillColor('#FFFFFF')
            Text('打开').fontSize(13).fontColor('#FFFFFF').margin({ left: 3 })
          }
          .justifyContent(FlexAlign.Center)
        }
        .type(ButtonType.Capsule)
        .backgroundColor('#0070E5')
        .width(64)
        .height(40)
        .margin({ right: 6 })
        .onClick(() => {
          this.openFile(task);
        })
        Button() {
          Row() {
            Image(iconRes('folder')).width(14).height(14).fillColor('#FFFFFF')
            Text('位置').fontSize(13).fontColor('#FFFFFF').margin({ left: 3 })
          }
          .justifyContent(FlexAlign.Center)
        }
        .type(ButtonType.Capsule)
        .backgroundColor('#666C78')
        .width(64)
        .height(40)
        .margin({ right: 6 })
        .onClick(() => {
          this.openFileLocation(task);
        })
      }
      Button() {
        Row() {
          Image(iconRes('trash')).width(14).height(14).fillColor('#FFFFFF')
          Text('删除').fontSize(13).fontColor('#FFFFFF').margin({ left: 3 })
        }
        .justifyContent(FlexAlign.Center)
      }
      .type(ButtonType.Capsule)
      .backgroundColor('#DB371A')
      .width(64)
      .height(40)
      .onClick(() => {
        this.showDeleteDialog([task], false);
      })
    }
    .height('100%')
    .padding({ left: 8, right: 8 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  TaskRow(task: DownloadTask) {
    Row() {
      if (this.selectMode) {
        Checkbox()
          .select(this.selectedTaskIds.has(task.id))
          .selectedColor(this.p.primarySolid)
          .shape(CheckBoxShape.ROUNDED_SQUARE)
          .width(22)
          .height(22)
          .margin({ right: 10 })
          .onChange((isChecked: boolean) => {
            const s = new Set(this.selectedTaskIds);
            if (isChecked) {
              s.add(task.id);
            } else {
              s.delete(task.id);
            }
            this.selectedTaskIds = s;
          })
      }
      Column() {
        Row() {
          // 文件类型图标
          Column() {
            if (fileTypeMeta(task.fileName).label) {
              // 安装包类型显示格式缩写
              Text(fileTypeMeta(task.fileName).label!)
                .fontSize(10)
                .fontColor('#FFFFFF')
                .fontWeight(FontWeight.Bold)
            } else {
              Image(iconRes(fileTypeMeta(task.fileName).icon))
                .width(22).height(22).fillColor(fileTypeMeta(task.fileName).color)
            }
          }
          .width(38).height(38)
          .justifyContent(FlexAlign.Center)
          .backgroundColor(fileTypeMeta(task.fileName).color + '22')
          .borderRadius(10)
          .margin({ right: 10 })

          Column() {
            Row() {
              Text(task.fileName)
                .fontSize(15)
                .fontColor(this.p.text)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              Text(protocolMeta(task.protocol).label)
                .fontSize(10)
                .fontColor('#FFFFFF')
                .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                .borderRadius(4)
                .backgroundColor(protocolMeta(task.protocol).color)
                .margin({ left: 8 })
            }
            .width('100%')
            Row() {
              Image(iconRes(statusIcon(task.status)))
                .width(13).height(13)
                .fillColor(task.status === TaskStatus.Error ? this.p.error :
                  (task.status === TaskStatus.Completed ? this.p.success : this.p.textSecondary))
                .margin({ right: 4 })
                .rotate(task.status === TaskStatus.Downloading ? { angle: this.rotateAngle } : { angle: 0 })
              Text(statusText(task.status)).fontSize(12).fontColor(this.p.textSecondary)
              if (task.status === TaskStatus.Downloading) {
                Text('  ' + formatSpeed(task.speed)).fontSize(12).fontColor(this.p.primaryDark)
              }
              Text(
                '  ' +
                  formatBytes(task.downloadedBytes) +
                  (task.totalBytes > 0 ? ' / ' + formatBytes(task.totalBytes) : '')
              )
                .fontSize(12)
                .fontColor(this.p.textSecondary)
            }
            .margin({ top: 4 })
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')

        if (task.totalBytes > 0) {
          Progress({ value: task.percent, total: 100, type: ProgressType.Linear })
            .width('100%')
            .margin({ top: 6 })
            .animation({ duration: 200, curve: Curve.Smooth })
            .color(this.p.primary)
        } else if (task.status === TaskStatus.Downloading) {
          Text('流式下载中…').fontSize(11).fontColor(this.p.textSecondary).margin({ top: 6 })
        }

        if (task.status === TaskStatus.Error) {
          Text(task.errorMessage)
            .fontSize(11)
            .fontColor(this.p.error)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 4 })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      // ── 右侧圆形操作按钮（原版样式） ──
      if (!this.selectMode) {
        this.TaskActionButton(task)
      }
    }
    .padding(12)
    .backgroundColor(this.selectMode && this.selectedTaskIds.has(task.id) ? this.p.primaryTint : this.p.surface)
            .borderRadius(RADIUS_CARD)
    .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
    .margin({ left: 12, right: 12, top: 6, bottom: 6 })
    .scale({ x: this.pressScale('task-' + task.id), y: this.pressScale('task-' + task.id) })
    .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
    .onTouch((event: TouchEvent) => {
      this.handlePress('task-' + task.id, event);
    })
  }

  @Builder
  TaskActionButton(task: DownloadTask) {
    Stack({ alignContent: this.winWidth < 600 ? Alignment.Center : Alignment.Center }) {
      if (task.status === TaskStatus.Downloading || task.status === TaskStatus.Queued) {
        Image(iconRes('pause')).width(18).height(18).fillColor('#FFFFFF')
      } else if (task.status === TaskStatus.Paused || task.status === TaskStatus.Error) {
        Image(iconRes('play')).width(18).height(18).fillColor('#FFFFFF')
      } else if (task.status === TaskStatus.Completed && task.seedingStatus !== 'none') {
        Image(iconRes('upload')).width(18).height(18).fillColor('#FFFFFF')
      } else if (task.status === TaskStatus.Completed) {
        Image(iconRes('check')).width(18).height(18).fillColor('#FFFFFF')
      } else {
        Image(iconRes('play')).width(18).height(18).fillColor('#FFFFFF')
      }
    }
    .width(36).height(36)
    .borderRadius(18)
    .backgroundColor(
      task.status === TaskStatus.Downloading || task.status === TaskStatus.Queued ? '#B06100' :
      task.status === TaskStatus.Paused || task.status === TaskStatus.Error ? '#388512' :
      task.status === TaskStatus.Completed ? '#388512' : this.p.surfaceSolid
    )
    .onClick(() => {
      if (task.status === TaskStatus.Downloading || task.status === TaskStatus.Queued) {
        this.vm.pause(task);
      } else if (task.status === TaskStatus.Paused || task.status === TaskStatus.Error) {
        this.vm.resume(task);
      } else if (task.status === TaskStatus.Completed && task.seedingStatus !== 'none') {
        this.vm.stopSeeding(task);
      }
    })
  }
}

// ── 新建下载页面 ──
@ComponentV2
struct AddContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();
  @Param navStack: NavPathStack = new NavPathStack();
  @Param onDownloadStart: () => void = (): void => {};
  @Local url: string = '';
  @Local urlFocused: boolean = false;
  @Local batchFocused: boolean = false;
  @Local autoFileName: string = '';
  @Local detectedLabel: string = '';
  @Local detectedColor: string = '';
  @Local detectedDesc: string = '';
  @Local detectedImpl: boolean = true;
  @Local detectedIcon: string = 'link';
  @Local hasDetection: boolean = false;
  @Local batchUrls: string = '';
  @Local selectedTorrentPath: string = '';
  private urlInputController: TextInputController = new TextInputController();
  private batchInputController: TextAreaController = new TextAreaController();
  // HLS quality selection state
  @Local hlsVariants: string[] = [];
  @Local hlsLabels: string[] = [];
  @Local hlsQualityIndex: number = -1;
  @Local hlsProbing: boolean = false;
  // Advanced options
  @Local showAdvanced: boolean = false;
  @Local saveDir: string = '';
  @Local segmentsDraft: string = '';
  @Local cookie: string = '';
  @Local referer: string = '';
  @Local customHeaders: string = '';

  /** Shared URL change handler: protocol detection + HLS probing. */
  private handleUrlInput(v: string): void {
    this.url = v;
    const trimmed = v.trim();
    if (trimmed.length > 0) {
      const meta = protocolMeta(detectProtocol(trimmed));
      this.detectedLabel = meta.label;
      this.detectedColor = meta.color;
      this.detectedDesc = meta.desc;
      this.detectedImpl = meta.implemented;
      this.detectedIcon = protocolIcon(detectProtocol(trimmed));
      this.hasDetection = true;
      this.autoFileName = fileNameFromUrl(trimmed);
      // Probe HLS variants when the URL looks like an m3u8 master playlist.
      this.hlsVariants = [];
      this.hlsQualityIndex = -1;
      if (meta.label === 'HLS' && trimmed.toLowerCase().endsWith('.m3u8')) {
        this.hlsProbing = true;
        probeHlsVariants(trimmed, this.vm.proxyConfig()).then((res: HlsVariantResult) => {
          this.hlsProbing = false;
          if (res.urls.length > 0) {
            this.hlsVariants = res.labels;
            // 变体已按 BANDWIDTH 降序，index 0 即最高清（自动档）
            this.hlsQualityIndex = 0;
          }
        }).catch(() => {
          this.hlsProbing = false;
        });
      } else {
        this.hlsProbing = false;
      }
    } else {
      this.hasDetection = false;
      this.autoFileName = '';
      this.hlsVariants = [];
      this.hlsQualityIndex = -1;
      this.hlsProbing = false;
    }
  }

  /** 将粘贴得到的文本填入输入框并识别协议。 */
  private applyPastedText(text: string): void {
    if (text && text.trim().length > 0) {
      this.handleUrlInput(text.trim());
    } else {
      safeToast(this.getUIContext(), '剪贴板中没有文本' );
    }
  }

  /** Read clipboard text into the URL field and run detection. */
  private pasteFromClipboard(): void {
    try {
      const sysPasteboard = pasteboard.getSystemPasteboard();
      sysPasteboard.getData().then((pasteData: pasteboard.PasteData) => {
        const recordCount = pasteData.getRecordCount();
        let text = pasteData.getPrimaryText() || '';
        logCollector.info('Pasteboard', `读取成功: records=${recordCount}, primaryText=${text?.slice(0, 80) || '(空)'}`);
        // 遍历所有记录
        for (let i = 0; i < recordCount; i++) {
          const record: pasteboard.PasteDataRecord = pasteData.getRecord(i);
          if (record) {
            const plain = record.toPlainText() || '';
            const html = record.htmlText || '';
            const uri = record.uri || '';
            if (!text && plain) text = plain;
            if (!text && html) text = html;
            if (!text && uri) text = uri;
          }
        }
        this.applyPastedText(text || '');
      }).catch((e: Error) => {
        logCollector.error('Pasteboard', `getData失败: ${JSON.stringify(e)}`);
        // 降级用同步方式
        try {
          const pasteData2 = sysPasteboard.getDataSync();
          const text2 = pasteData2.getPrimaryText() || '';
          logCollector.info('Pasteboard', `同步降级读取: ${text2?.slice(0, 80) || '(空)'}`);
          this.applyPastedText(text2);
        } catch (e2) {
          logCollector.error('Pasteboard', `同步降级也失败: ${JSON.stringify(e2)}`);
          safeToast(this.getUIContext(), '读取剪贴板失败，请长按输入框选择粘贴' );
        }
      });
    } catch (e) {
      logCollector.error('Pasteboard', `pasteFromClipboard异常: ${JSON.stringify(e)}`);
      safeToast(this.getUIContext(), '读取剪贴板失败，请长按输入框选择粘贴' );
    }
  }

  /** Pick a .txt file and load each line as a batch download URL. */
  async importTxtLinks(): Promise<void> {
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const documentPicker = new picker.DocumentViewPicker(context);
      const options = new picker.DocumentSelectOptions();
      options.fileSuffixFilters = ['.txt'];
      const results = await documentPicker.select(options);
      if (!results || results.length === 0) {
        return;
      }
      const uri = results[0];
      const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      try {
        const stat = fs.statSync(uri);
        const buf = new ArrayBuffer(stat.size > 0 ? stat.size : 4096);
        const read = fs.readSync(file.fd, buf);
        const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
        const text = decoder.decodeToString(new Uint8Array(buf.slice(0, read)));
        const existing = new Set(this.batchUrls.split('\n').map((s: string) => s.trim()).filter((s: string) => s.length > 0));
        const lines = text.split('\n').map((s: string) => s.trim()).filter((s: string) => s.length > 0 && !existing.has(s));
        this.batchUrls = (this.batchUrls.trim().length > 0 ? this.batchUrls.trim() + '\n' : '') + lines.join('\n');
        safeToast(this.getUIContext(), `已导入 ${lines.length} 条链接` );
      } finally {
        fs.closeSync(file.fd);
      }
    } catch (e) {
      safeToast(this.getUIContext(), '导入 TXT 失败: ' + ((e as Error)?.message || String(e)) );
    }
  }

  /** Open system file picker to select a .torrent file. */
  async pickTorrentFile(): Promise<void> {    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const documentPicker = new picker.DocumentViewPicker(context);
      const options = new picker.DocumentSelectOptions();
      // Filter for .torrent files
      options.fileSuffixFilters = ['.torrent'];
      const results = await documentPicker.select(options);
      if (results && results.length > 0) {
        const uri = results[0];
        this.selectedTorrentPath = uri;
        this.url = uri;
        // Auto-detect protocol
        const trimmed = uri.trim();
        if (trimmed.length > 0) {
          const meta = protocolMeta(detectProtocol(trimmed));
          this.detectedLabel = meta.label;
          this.detectedColor = meta.color;
          this.detectedDesc = meta.desc;
          this.detectedImpl = meta.implemented;
          this.detectedIcon = protocolIcon(detectProtocol(trimmed));
          this.hasDetection = true;
          this.autoFileName = fileNameFromUrl(trimmed) || uri.split('/').pop() || '';
        }
        safeToast(this.getUIContext(), '已选择种子文件' );
      }
    } catch (e) {
      safeToast(this.getUIContext(), '选择文件失败: ' + (e as Error).message );
    }
  }

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  @Computed
  get tintColor(): string {
    return this.vm.iconTint === 'mono' ? this.p.text : this.p.primary;
  }

  @Builder
  ProtocolChip(label: string, color: string, implemented: boolean, icon: string) {
    Row() {
      Image(iconRes(icon))
        .width(14).height(14).fillColor(color)
        .margin({ right: 5 })
      Text(label)
        .fontSize(12)
        .fontColor(color)
    }
    .padding({ left: 10, right: 10, top: 6, bottom: 6 })
    .borderRadius(8)
    .backgroundColor('#' + '26' + color.substring(1))
  }

  /** 检测到重复下载链接时弹出询问对话框。 */
  private showDuplicateDialog(): void {
    const info = this.vm.duplicatePrompt;
    if (!info) {
      return;
    }
    this.getUIContext().showAlertDialog({
      title: '重复下载',
      message: `链接「${info.url.length > 60 ? info.url.slice(0, 57) + '...' : info.url}」\n已存在下载任务，是否重新下载？原文件将保留。`,
      autoCancel: false,
      alignment: DialogAlignment.Center,
      primaryButton: {
        value: '跳过',
        action: () => {
          this.vm.confirmDuplicateDownload('skip');
        }
      },
      secondaryButton: {
        value: '重新下载',
        fontColor: this.p.primary,
        action: () => {
          this.vm.confirmDuplicateDownload('redownload').then(() => {
            safeToast(this.getUIContext(), '已重新添加下载任务' );
            this.onDownloadStart?.();
          });
        }
      }
    });
  }

  build() {
    Scroll() {
      Column() {
      // ── 标题 ──
      Text('新建下载')
        .fontSize(18).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        .width('100%').textAlign(TextAlign.Center)
        .margin({ bottom: 12 })
      // ── 下载链接（卡片式输入区） ──
      Row() {
        Image(iconRes('link')).width(18).height(18).fillColor(this.tintColor).margin({ right: 10 })
        Text('下载链接').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        Blank()
        Text('支持 HTTP / BT / 磁力 / eD2K 等')
          .fontSize(11).fontColor(this.p.textSecondary)
      }
      .width('100%')
      .margin({ bottom: 10 })

      Row() {
        // 协议图标（有输入时显示已识别协议）
        Image(iconRes(this.url.trim().length > 0 && this.hasDetection ? this.detectedIcon : 'link'))
          .width(18).height(18)
          .fillColor(this.url.trim().length > 0 && this.hasDetection ? this.detectedColor : this.p.textSecondary)
          .margin({ left: 4, right: 10 })

        TextInput({ placeholder: '粘贴或输入下载链接，自动识别协议', text: this.url, controller: this.urlInputController }).caretColor(this.p.primary)
          .fontColor(this.p.text)
          .placeholderColor(this.p.textSecondary)
          .fontSize(14)
          .layoutWeight(1)
          .backgroundColor(Color.Transparent)
          .onChange((v: string) => {
            this.handleUrlInput(v);
          })
          .onFocus(() => { this.urlFocused = true; })
          .onBlur(() => { this.urlFocused = false; })

        if (this.url.length > 0) {
          Image(iconRes('x'))
            .width(16).height(16)
            .fillColor(this.p.textSecondary)
            .margin({ left: 6, right: 6 })
            .onClick(() => {
              this.handleUrlInput('');
              this.url = '';
            })
        }
      }
      .width('100%')
      .height(52)
      .padding({ left: 12, right: 10 })
      .backgroundColor(this.vm.theme === 'dark' ? '#2C2C2E' : '#F2F2F7')
      .borderRadius(12)
      .border({
        width: this.urlFocused ? 1.5 : 1,
        color: this.urlFocused ? this.p.primary : this.p.border
      })
      .shadow({
        radius: this.urlFocused ? 10 : 2,
        color: this.urlFocused ? this.p.primary + '33' : '#11000000',
        offsetY: this.urlFocused ? 2 : 0
      })
      .animation({ duration: 180, curve: Curve.EaseOut })

      // 实时协议检测徽章
      if (this.hasDetection) {
        Row() {
          Row() {
            Image(iconRes(this.detectedIcon))
              .width(14).height(14).fillColor(this.detectedColor)
              .margin({ right: 4 })
            Text(this.detectedLabel).fontSize(12).fontColor(this.p.text)
            Text(this.detectedDesc).fontSize(11).fontColor(this.p.textSecondary).margin({ left: 6 })
          }
          .layoutWeight(1)

          if (!this.detectedImpl) {
            Text('未实现').fontSize(10).fontColor(this.p.error)
          }
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
        .backgroundColor(this.p.surface)
                .borderRadius(8)
        .margin({ top: 8 })
      }

      // 自动识别文件名预览
      if (this.autoFileName.length > 0) {
        Row() {
          Text('文件名').fontSize(13).fontColor(this.p.textSecondary)
          Text(this.autoFileName)
            .fontSize(13)
            .fontColor(this.p.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .margin({ left: 8 })
        }
        .width('100%')
        .margin({ top: 12 })
      }

      // HLS 清晰度选择（探测 master playlist 变体）
      if (this.hasDetection && this.detectedLabel === 'HLS') {
        Row() {
          Text('清晰度').fontSize(13).fontColor(this.p.textSecondary)
          Blank()
          if (this.hlsProbing) {
            Text('探测中…').fontSize(12).fontColor(this.p.textSecondary)
          } else if (this.hlsVariants.length === 0) {
            Text('自动（最高画质）').fontSize(12).fontColor(this.p.textSecondary)
          }
        }
        .width('100%')
        .margin({ top: 12 })

        if (this.hlsVariants.length > 0) {
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.hlsVariants, (label: string, idx: number) => {
              Text(label)
                .fontSize(12)
                .fontColor(this.hlsQualityIndex === idx ? this.p.onPrimary : this.p.text)
                .padding({ left: 10, right: 10, top: 5, bottom: 5 })
                .borderRadius(10)
                .backgroundColor(this.hlsQualityIndex === idx ? this.p.primarySolid : this.p.surface)
                .margin({ right: 6, bottom: 6 })
                .onClick(() => {
                  this.hlsQualityIndex = idx;
                })
            }, (label: string) => label)
          }
          .width('100%')
          .margin({ top: 6 })
        }
      }

      // 选择种子文件
      Row() {
        Button() {
          Row() {
            Image(iconRes('folder_open')).width(18).height(18).fillColor(this.p.text)
            Text('选择 .torrent 种子文件').fontSize(14).margin({ left: 8 })
          }
          .justifyContent(FlexAlign.Center)
        }
          .fontSize(14)
          .height(44)
          .padding({ left: 20, right: 20 })
          .backgroundColor(this.p.surface)
          .fontColor(this.p.text)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(10)
          .onClick(() => {
            this.pickTorrentFile();
          })
        if (this.selectedTorrentPath.length > 0) {
          Text('已选择: ' + this.selectedTorrentPath.split('/').pop())
            .fontSize(12)
            .fontColor(this.p.success)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .margin({ left: 12 })
        }
      }
      .width('100%')
      .margin({ top: 14 })

      // ── 高级选项（折叠） ──
      Row() {
        Image(iconRes('sliders'))
          .width(15).height(15).fillColor(this.p.textSecondary)
          .margin({ right: 6 })
        Text('高级选项').fontSize(14).fontColor(this.p.text).layoutWeight(1)
        Image(iconRes(this.showAdvanced ? 'maximize' : 'minimize'))
          .width(16).height(16).fillColor(this.p.textSecondary)
      }
      .width('100%')
      .padding({ top: 12, bottom: 12 })
      .onClick(() => { this.showAdvanced = !this.showAdvanced; })

      if (this.showAdvanced) {
        Column() {
          // 保存路径
          Text('保存路径').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          Row() {
            TextInput({ placeholder: '留空使用默认目录', text: this.saveDir }).caretColor(this.p.primary)
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(13)
              .layoutWeight(1)
              .backgroundColor(this.p.surface)
              .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
              .borderRadius(8)
              .height(40)
              .onChange((v: string) => { this.saveDir = v; })
          }
          .width('100%')
          .margin({ bottom: 12 })

          // 线程数
          Text('线程数（留空=默认）').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          TextInput({ placeholder: '如 16', text: this.segmentsDraft }).caretColor(this.p.primary)
            .fontColor(this.p.text)
            .placeholderColor(this.p.textSecondary)
            .fontSize(13)
            .width('100%')
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(8)
            .height(40)
            .type(InputType.Number)
            .margin({ bottom: 12 })
            .onChange((v: string) => { this.segmentsDraft = v; })

          // Cookie
          Text('Cookie').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          TextInput({ placeholder: 'name=value; name2=value2', text: this.cookie }).caretColor(this.p.primary)
            .fontColor(this.p.text)
            .placeholderColor(this.p.textSecondary)
            .fontSize(13)
            .width('100%')
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(8)
            .height(40)
            .margin({ bottom: 12 })
            .onChange((v: string) => { this.cookie = v; })

          // Referer
          Text('Referer').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          TextInput({ placeholder: 'https://example.com', text: this.referer }).caretColor(this.p.primary)
            .fontColor(this.p.text)
            .placeholderColor(this.p.textSecondary)
            .fontSize(13)
            .width('100%')
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(8)
            .height(40)
            .margin({ bottom: 12 })
            .onChange((v: string) => { this.referer = v; })

          // 自定义请求头
          Text('自定义请求头（每行 Key: Value）').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          TextArea({ placeholder: 'X-Key: value\nAuthorization: Bearer xxx', text: this.customHeaders }).caretColor(this.p.primary)
            .fontColor(this.p.text)
            .placeholderColor(this.p.textSecondary)
            .fontSize(13)
            .width('100%')
            .height(80)
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(8)
            .onChange((v: string) => { this.customHeaders = v; })
        }
        .width('100%')
        .padding({ left: 4, right: 4, bottom: 4 })
      }

      Button() {
        Row() {
          Image(iconRes('download')).width(18).height(18).fillColor(this.p.onPrimary)
          Text('开始下载').fontSize(16).fontColor(this.p.onPrimary).margin({ left: 6 })
        }
        .justifyContent(FlexAlign.Center)
      }
        .width('100%')
        .height(44)
        .backgroundColor(this.p.primarySolid)
        .fontColor(this.p.onPrimary)
        .borderRadius(22)
        .margin({ top: 24 })
        .enabled(this.url.trim().length > 0)
        .onClick(() => {
          if (this.url.trim().length === 0) {
            return;
          }
          const quality = this.detectedLabel === 'HLS' && this.hlsQualityIndex >= 0 ? this.hlsQualityIndex : -1;
          const segCount = this.segmentsDraft.trim().length > 0 ? parseInt(this.segmentsDraft) : undefined;
          this.vm.addDownload(this.url.trim(), undefined, quality, '', {
            dirPath: this.saveDir.trim().length > 0 ? this.saveDir.trim() : undefined,
            segmentCount: segCount,
            cookie: this.cookie.trim().length > 0 ? this.cookie.trim() : undefined,
            referer: this.referer.trim().length > 0 ? this.referer.trim() : undefined,
            headers: this.customHeaders.trim().length > 0 ? this.customHeaders.trim() : undefined,
          }).then((result: 'added' | 'duplicate' | 'pending' | 'skipped') => {
            if (result === 'duplicate') {
              this.showDuplicateDialog();
              return;
            }
            if (result === 'pending') {
              // 正在添加中，不关闭弹窗
              return;
            }
            // added：清空输入框，显示 toast，关闭弹窗
            this.url = '';
            this.autoFileName = '';
            this.hasDetection = false;
            this.hlsVariants = [];
            this.hlsQualityIndex = -1;
            this.saveDir = '';
            this.segmentsDraft = '';
            this.cookie = '';
            this.referer = '';
            this.customHeaders = '';
            this.showAdvanced = false;
            this.selectedTorrentPath = '';
            safeToast(this.getUIContext(), '已添加下载任务' );
            this.onDownloadStart?.();
          });
        })

      // ── 批量下载 ──
      Divider().color(this.p.border).margin({ top: 24, bottom: 16 })

      Text('批量下载').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        .margin({ bottom: 8 })
      Text('每行一个 URL（仅支持 http/https）').fontSize(12).fontColor(this.p.textSecondary)
        .margin({ bottom: 8 })

      Column() {
        TextArea({ text: this.batchUrls, placeholder: 'https://example.com/file1.zip\nhttps://example.com/file2.zip', controller: this.batchInputController }).caretColor(this.p.primary)
          .fontColor(this.p.text)
          .placeholderColor(this.p.textSecondary)
          .width('100%')
          .height(100)
          .fontSize(13)
          .backgroundColor(Color.Transparent)
          .padding(10)
          .onFocus(() => { this.batchFocused = true; })
          .onBlur(() => { this.batchFocused = false; })
          .onChange((v: string) => {
          // 检测粘贴操作：内容变化较大时自动格式化
          const diff = Math.abs(v.length - this.batchUrls.length);
          if (diff > 3) {
            // 粘贴操作：自动格式化
            let formatted = v;
            // 在每个协议前缀前面加换行符（如果前面不是换行符或开头），自动分隔连续的URL
            formatted = formatted.replace(/(?<=.)(https?:\/\/|magnet:\?|ed2k:\/\/|ftp:\/\/|sftp:\/\/|thunder:\/\/|flashget:\/\/|qqdl:\/\/)/g, '\n$1');
            // 把连续的空格、制表符替换成换行
            formatted = formatted.replace(/[ \t]+/g, '\n');
            // 把逗号、分号替换成换行
            formatted = formatted.replace(/[,;]+/g, '\n');
            // 去掉多余的空行
            formatted = formatted.replace(/\n{2,}/g, '\n');
            // 去掉每行首尾空格
            const lines = formatted.split('\n').map((line: string) => line.trim()).filter((line: string) => line.length > 0);
            // 强制在末尾加换行符，光标移到下一行
            formatted = lines.join('\n') + '\n';
            this.batchUrls = formatted;
            return;
          }
          this.batchUrls = v;
        })
      }
      .width('100%')
      .backgroundColor(this.vm.theme === 'dark' ? '#2C2C2E' : '#F2F2F7')
      .borderRadius(12)
      .border({
        width: this.batchFocused ? 1.5 : 1,
        color: this.batchFocused ? this.p.primary : this.p.border
      })

      Row({ space: 12 }) {
        Stack({ alignContent: Alignment.Center }) {
          ImmersionButton({
            systemMaterialEffect: buildMaterialEffect(this.vm.glassStyle, this.vm.glassLevel),
            text: '从 TXT 导入',
            buttonModify: new ActionButtonModifier('100%', 44),
            click: (): void => { this.importTxtLinks(); }
          })
          .width('100%')
          .height(44)
        }
        .layoutWeight(1)
        .height(44)
        Stack({ alignContent: Alignment.Center }) {
          ImmersionButton({
            systemMaterialEffect: buildMaterialEffect(this.vm.glassStyle, this.vm.glassLevel),
            text: '批量添加',
            buttonModify: new ActionButtonModifier('100%', 44),
            click: (): void => {
              if (this.batchUrls.trim().length === 0) return;
            const urls = this.batchUrls.split('\n').map(u => u.trim()).filter(u => u.length > 0);
            this.vm.addBatchDownloads(urls).then((n: number) => {
              if (this.vm.duplicatePrompt) {
                // 有重复链接，弹出对话框
                this.showDuplicateDialog();
              }
              if (n > 0) {
                safeToast(this.getUIContext(), `已添加 ${n} 个下载` );
              }
              this.batchUrls = '';
              if (n > 0) {
                this.onDownloadStart?.();
              }
            });
          }
        })
        .width('100%')
        .height(44)
        }
        .layoutWeight(1)
        .height(44)
      }
      .width('100%')
      .margin({ top: 12 })
    }
    .padding(20)
    .width('100%')
    .backgroundColor(Color.Transparent)
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      // 点击空白处退出输入法
      this.urlInputController.stopEditing();
      this.batchInputController.stopEditing();
    })
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Off)
    .contentEndOffset((AppStorage.get<number>('fluxdown_naviIndicatorHeight') ?? 0) + 52 + 16 + 16)
    .edgeEffect(EdgeEffect.Spring)
  }
}

// 配色分组：设置页按 经典 / 莫兰迪 两组展示（COLOR_SCHEMES 里 group 已标好）
const CLASSIC_SCHEMES: ColorScheme[] = COLOR_SCHEMES.filter((s: ColorScheme) => s.group === 'classic');
const MORANDI_SCHEMES: ColorScheme[] = COLOR_SCHEMES.filter((s: ColorScheme) => s.group === 'morandi');

// ── 设置页面 ──
@ComponentV2
struct SettingsContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();
  @Param navStack: NavPathStack = new NavPathStack();
  /** 页面模式：'' = 设置首页卡片列表；非空（appearance/download/bt/mcp/ext/queue/cat/rss）= 对应功能独立页 */
  @Param mode: string = '';
  @Local rssUrl: string = '';
  @Local rssName: string = '';
  @Local rssFilter: string = '';
  @Local rssExclude: string = '';
  // RSS editor state
  @Local rssEditVisible: boolean = false;
  @Local rssEditTarget: RssSubscription | null = null;
  @Local rssEditInterval: string = '30';
  @Local rssEditAuto: boolean = true;
  @Local rssEditExclude: string = '';
  @Local rssEditSizeMin: string = '0';
  @Local rssEditSizeMax: string = '0';
  @Local rssEditQueueId: string = '';
  // Category editor state
  @Local catName: string = '';
  @Local catExts: string = '';
  @Local catDir: string = '';
  @Local catEditId: string = '';
  @Local catEditName: string = '';
  @Local catEditExts: string = '';
  @Local catEditDir: string = '';
  @Local catEditVisible: boolean = false;
  // Queue editor state
  @Local newQueueName: string = '';
  @Local queueAdvId: string = ''; // queue id currently editing advanced settings ('' = none)
  @Local queueSegDraft: string = '';
  @Local queueUaDraft: string = '';
  @Local queueDirDraft: string = '';
  // Download policy drafts
  @Local retryCountDraft: string = '';
  @Local retryDelayDraft: string = '';
  // BT settings drafts
  @Local btPortStartDraft: string = '';
  @Local btPortEndDraft: string = '';
  @Local btRatioDraft: string = '';
  @Local btTimeDraft: string = '';
  @Local btInactiveDraft: string = '';
  @Local btUploadDraft: string = '';
  @Local btMaxActiveDraft: string = '';
  // 即时刷新镜像（PolicyChip 的 @Builder 参数在 V2 细粒度更新下不刷新，用本地状态镜像）
  @Local fileExistsBehaviorLocal: string = '';
  @Local fileMissingActionLocal: string = '';
  @Local btOperatorLocal: string = '';
  @Local glassLevelLocal: string = '';
  @Local iconTintLocal: string = '';
  // 设置分组折叠状态（默认全部收起）
  @Local sectionDownload: boolean = false;
  @Local sectionAppearance: boolean = false;
  @Local sectionMcp: boolean = false;
  @Local sectionBt: boolean = false;
  @Local sectionRss: boolean = false;
  // 当前被按下的卡片式入口 key（统一物理按压反馈）
  @Local pressedKey: string = '';
  // 顶部状态栏 / 底部导航安全区高度（EntryAbility 发布到 AppStorage），用于内容避让悬浮标题栏/底部导航
  @Local statusBarHeight: number = 0;
  @Local naviIndicatorHeight: number = 0;

  aboutToAppear(): void {
    this.fileExistsBehaviorLocal = this.vm.fileExistsBehavior;
    this.fileMissingActionLocal = this.vm.fileMissingAction;
    if (this.vm.btSettings) {
      this.btOperatorLocal = this.vm.btSettings.limits.operator === SeedConditionOperator.AND ? 'and' : 'or';
    }
    this.glassLevelLocal = this.vm.glassLevel;
    this.iconTintLocal = this.vm.iconTint;
    this.statusBarHeight = AppStorage.get<number>('fluxdown_statusBarHeight') ?? 0;
    this.naviIndicatorHeight = AppStorage.get<number>('fluxdown_naviIndicatorHeight') ?? 0;
  }

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  @Computed
  get tintColor(): string {
    return this.vm.iconTint === 'mono' ? this.p.text : this.p.primary;
  }

  /** 同步窗口背景色和系统栏属性（App内手动切换主题时调用，避免底部安全区透出旧窗口背景色） */
  private applyWindowAppearance(isDark: boolean): void {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      window.getLastWindow(ctx).then((win: window.Window) => {
        win.setWindowBackgroundColor(isDark ? '#FF000000' : '#FFE8EBF0');
        win.setWindowSystemBarProperties({
          statusBarColor: '#00000000',
          navigationBarColor: isDark ? '#FF000000' : '#FFE8EBF0',
          isStatusBarLightIcon: isDark,
          isNavigationBarLightIcon: isDark,
          navigationBarContentColor: isDark ? '#FFEEEEEE' : '#FF1A1A1A',
          statusBarContentColor: isDark ? '#FFEEEEEE' : '#FF1A1A1A'
        });
      }).catch((_e: Error) => {});
    } catch (_e) {}
  }

  /** 跟随系统时根据系统颜色模式同步主题和窗口背景 */
  private updateSystemTheme(): void {
    if (this.vm.themeMode !== 'system') {
      return;
    }
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const isDark = ctx.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
      const target: 'light' | 'dark' = isDark ? 'dark' : 'light';
      if (this.vm.theme !== target) {
        this.vm.setTheme(target);
        this.applyWindowAppearance(isDark);
      }
    } catch (_e) {}
  }

  /** 统一按压反馈：按下时返回 PRESS_SCALE，否则 1 */
  private pressScale(key: string): number {
    return this.pressedKey === key ? PRESS_SCALE : 1;
  }

  /** 统一按压反馈：绑定到 onTouch，Down 记录、Up/Cancel 释放 */
  private handlePress(key: string, event: TouchEvent): void {
    if (event.type === TouchType.Down) {
      this.pressedKey = key;
    } else if ((event.type === TouchType.Up || event.type === TouchType.Cancel) && this.pressedKey === key) {
      this.pressedKey = '';
    }
  }

  /**
   * 打开外部链接。必须用 openLink：直接 startAbility({ bundleName, uri })
   * 指定浏览器包名时，系统匹配不到可处理 https 的 Ability，会弹「暂无可打开方式」。
   */
  private openExternalUrl(url: string): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    ctx.openLink(url, { appLinkingOnly: false } as OpenLinkOptions)
      .then(() => {
        // 系统已拉起浏览器
      })
      .catch(() => {
        // 降级：显式声明 viewData + browsable，让系统自行匹配浏览器
        const want: Want = {
          action: 'ohos.want.action.viewData',
          entities: ['entity.system.browsable'],
          uri: url
        };
        ctx.startAbility(want).catch(() => {
          pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, url));
          safeToast(this.getUIContext(), '链接已复制，请在浏览器中粘贴打开' );
        });
      });
  }

  /** 打开QQ群：检测QQ，有QQ直接跳转，没QQ用浏览器打开 */
  private openQQGroup(): void {
    const groupNumber = '1121565536';
    const h5Url = 'https://qun.qq.com/universal-share/share?ac=1&authKey=Jcxm9Kgi22K0O%2FPwws6chnIVQSjKNpEAcfq0tADTNJ1EwMFzohA4YOlXuwOz%2B8xz&busi_data=eyJncm91cENvZGUiOiIxMTIxNTY1NTM2IiwidG9rZW4iOiJwSzBkNTFKSGFGbXRjZk5pOFE0aGtQSDZSMHN0MnExWVJGcDR6WlgzeE5VcEJ0M3JTcnIrZHNlc0kzK3RRV1lJIiwidWluIjoiMTAxMjQ0MzU1NyJ9&data=Hvy3TedB6d7PgopsRuZzjY00d9OYpE_-5ASDCIym0LPHvCNBY6s7Q6IAdChl4iYB5L1L6r7YVZ4fQz0Dio5PGQ&svctype=4&tempid=h5_group_info';
    const qqScheme = `mqqapi://card/show_pslcard?src_type=internal&version=1&uin=${groupNumber}&card_type=group&source=qrcode`;

    // 检测是否安装了QQ
    const qqBundles = ['com.tencent.mobileqq', 'com.tencent.tim', 'com.tencent.qq', 'com.tencent.mobileqqi', 'com.tencent.minihd.qq'];
    let hasQQ = false;
    for (const bn of qqBundles) {
      try {
        bundleManager.getBundleInfo(bn, bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
        hasQQ = true;
        break;
      } catch (_) { }
    }

    if (hasQQ) {
      // 有 QQ，直接跳转 QQ 加群
      const want: Want = { uri: qqScheme };
      (this.getUIContext().getHostContext() as common.UIAbilityContext).startAbility(want).catch(() => {
        // QQ 跳转失败 → 用系统浏览器打开分享页
        this.openExternalUrl(h5Url);
      });
    } else {
      // 没装 QQ → 交给系统按 scheme 解析（指定浏览器包名反而会弹「暂无可打开方式」）
      this.openExternalUrl(h5Url);
    }
  }

  /** 长按QQ群：复制群号 */
  private copyQQGroupNumber(): void {
    const groupNumber = '1121565536';
    try {
      pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, groupNumber));
      safeToast(this.getUIContext(), '群号已复制: ' + groupNumber );
    } catch (e) {
      safeToast(this.getUIContext(), '复制失败，请手动记录群号 ' + groupNumber );
    }
  }

  private minToTime(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  private timeToDate(min: number): Date {
    const d = new Date();
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    return d;
  }

  private addCategory(): void {
    const name = this.catName.trim();
    if (name.length === 0) {
      safeToast(this.getUIContext(), '请输入分类名称' );
      return;
    }
    this.vm.createCategory(name, this.catExts.trim(), this.catDir.trim()).then(() => {
      this.catName = '';
      this.catExts = '';
      this.catDir = '';
      safeToast(this.getUIContext(), '已添加分类' );
    });
  }

  private saveCategoryEdit(): void {
    const cat = this.vm.categories.find(c => c.id === this.catEditId);
    if (!cat) {
      this.catEditVisible = false;
      return;
    }
    const name = this.catEditName.trim();
    if (name.length === 0) {
      safeToast(this.getUIContext(), '分类名称不能为空' );
      return;
    }
    this.vm.updateCategory(cat, { name: name, extensions: this.catEditExts.trim(), saveDir: this.catEditDir.trim() })
      .then(() => {
        this.catEditVisible = false;
        safeToast(this.getUIContext(), '已保存分类' );
      });
  }

  build() {
    Stack() {
      Scroll() {
        Column() {
        // ── 外观 ──
        if (this.mode === '' || this.mode === 'appearance') {
        Column() {
          Row() {
            Image(iconRes('palette')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('外观').fontSize(15).fontColor(this.p.text).layoutWeight(1)
            if (this.mode === '') {
              Image(iconRes('chevron_right'))
                .width(16).height(16).fillColor(this.p.textSecondary)
            }
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })
          .scale({ x: this.pressScale('secAppearance'), y: this.pressScale('secAppearance') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => {
            this.handlePress('secAppearance', event);
          })
          .onClick(() => {
            if (this.mode === '') {
              this.navStack.pushPath({ name: 'setting', param: 'appearance' });
            }
          })

          if (this.mode !== '' || this.sectionAppearance) {
            Divider().color(this.p.border).margin({ left: 16, right: 16 })
            Column() {
              Row() {
                Image(iconRes(this.vm.theme === 'dark' ? 'moon' : 'sun')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
                Text('主题').fontColor(this.p.text).layoutWeight(1).fontSize(15)
              }
              .width('100%')
              .padding({ left: 16, right: 16, top: 14, bottom: 8 })

              Row() {
                this.ThemeChip('浅色', 'light')
                this.ThemeChip('深色', 'dark')
                this.ThemeChip('跟随系统', 'system')
              }
              .width('100%')
              .padding({ left: 12, right: 12, bottom: 14 })

              Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('palette')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('配色').fontColor(this.p.text).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, top: 12, bottom: 4 })

          // ── 配色（按 经典 / 莫兰迪 分组，色块下方显示对应名称）──
          // 注意：两组色卡样式完全一致，改样式时请同步两处。
          // 未抽成 @Builder 是因为本组件在 V2 细粒度更新下曾出现 @Builder 参数不刷新的问题
          // （见上方 PolicyChip 相关说明），内联最稳妥。
          Column() {
            // 左边界与「配色」「外观」等分区标题及分隔线保持一致（均为 16），不再额外缩进
            Text('经典')
              .fontSize(12)
              .fontColor(this.p.textSecondary)
              .margin({ top: 4, bottom: 2 })
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(CLASSIC_SCHEMES, (scheme: ColorScheme) => {
                Column() {
                  Column()
                    .width(36)
                    .height(36)
                    .borderRadius(18)
                    // 必须展示 "真正应用到界面上" 的主色（即 palette() 里经 ensureContrast 压缩后的
                    // readablePrimary / darkPrimary），而不是 scheme.primary 原色。
                    // 否则色卡与实际应用效果不一致 —— 会出现"选了不同色却看起来一样"的错觉。
                    .backgroundColor(palette(this.vm.theme, scheme.id).primary)
                    .border({
                      width: this.vm.colorScheme === scheme.id ? 3 : 0,
                      color: this.p.text
                    })
                  // 名称：选中项用主题主色 + 中粗，其余用次要文字色，便于辨认当前配色
                  Text(scheme.name)
                    .fontSize(10)
                    .maxLines(1)
                    .textAlign(TextAlign.Center)
                    .width(56)
                    .margin({ top: 4 })
                    .fontColor(this.vm.colorScheme === scheme.id ? this.p.primary : this.p.textSecondary)
                    .fontWeight(this.vm.colorScheme === scheme.id ? FontWeight.Medium : FontWeight.Normal)
                }
                .width(56)
                .margin(8)
                .onClick(() => { this.vm.setColorScheme(scheme.id); })
              })
            }

            Text('莫兰迪')
              .fontSize(12)
              .fontColor(this.p.textSecondary)
              .margin({ top: 12, bottom: 2 })
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(MORANDI_SCHEMES, (scheme: ColorScheme) => {
                Column() {
                  Column()
                    .width(36)
                    .height(36)
                    .borderRadius(18)
                    .backgroundColor(palette(this.vm.theme, scheme.id).primary)
                    .border({
                      width: this.vm.colorScheme === scheme.id ? 3 : 0,
                      color: this.p.text
                    })
                  Text(scheme.name)
                    .fontSize(10)
                    .maxLines(1)
                    .textAlign(TextAlign.Center)
                    .width(56)
                    .margin({ top: 4 })
                    .fontColor(this.vm.colorScheme === scheme.id ? this.p.primary : this.p.textSecondary)
                    .fontWeight(this.vm.colorScheme === scheme.id ? FontWeight.Medium : FontWeight.Normal)
                }
                .width(56)
                .margin(8)
                .onClick(() => { this.vm.setColorScheme(scheme.id); })
              })
            }
          }
          .padding({ left: 16, right: 16, top: 8, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // ── 材质浓度（模糊/光感的强弱档位）──
          Row() {
            Image(iconRes('gauge')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('材质浓度').fontColor(this.p.text).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, top: 12, bottom: 4 })

          Row() {
            Text('自动')
              .fontSize(12)
              .fontColor(this.glassLevelLocal === 'auto' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.glassLevelLocal === 'auto' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.glassLevelLocal = 'auto'; this.vm.setGlassLevel('auto'); })
            Text('浓郁')
              .fontSize(12)
              .fontColor(this.glassLevelLocal === 'high' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.glassLevelLocal === 'high' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.glassLevelLocal = 'high'; this.vm.setGlassLevel('high'); })
            Text('适中')
              .fontSize(12)
              .fontColor(this.glassLevelLocal === 'medium' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.glassLevelLocal === 'medium' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.glassLevelLocal = 'medium'; this.vm.setGlassLevel('medium'); })
            Text('清淡')
              .fontSize(12)
              .fontColor(this.glassLevelLocal === 'low' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.glassLevelLocal === 'low' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.glassLevelLocal = 'low'; this.vm.setGlassLevel('low'); })
          }
          .width('100%')
          .padding({ left: 16, top: 4, bottom: 8 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // ── 图标着色（顶部/底部等框架图标用主题色还是中性单色）──
          Row() {
            Image(iconRes('eye')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('图标着色').fontColor(this.p.text).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, top: 12, bottom: 4 })

          Row() {
            Text('主题色')
              .fontSize(12)
              .fontColor(this.iconTintLocal === 'accent' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.iconTintLocal === 'accent' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.iconTintLocal = 'accent'; this.vm.setIconTint('accent'); })
            Text('单色')
              .fontSize(12)
              .fontColor(this.iconTintLocal === 'mono' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.iconTintLocal === 'mono' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.iconTintLocal = 'mono'; this.vm.setIconTint('mono'); })
          }
          .width('100%')
          .padding({ left: 16, top: 4, bottom: 16 })
            }
          }
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

        // ── 下载（合并卡片：下载设置 + BT下载，仅设置首页显示） ──
        if (this.mode === '') {
        Column() {
          // 下载设置入口
          Row() {
            Image(iconRes('download')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('下载设置').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
          }
          .width('100%')
          .padding(16)
          .scale({ x: this.pressScale('menuDownload'), y: this.pressScale('menuDownload') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => { this.handlePress('menuDownload', event); })
          .onClick(() => { this.navStack.pushPath({ name: 'setting', param: 'download' }); })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // BT下载入口
          Row() {
            Image(iconRes('magnet')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('BT 下载').fontColor(this.p.text).layoutWeight(1).fontSize(15).padding({ left: -1 })
            Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
          }
          .width('100%')
          .padding(16)
          .scale({ x: this.pressScale('menuBt'), y: this.pressScale('menuBt') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => { this.handlePress('menuBt', event); })
          .onClick(() => { this.navStack.pushPath({ name: 'setting', param: 'bt' }); })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 下载统计入口
          Row() {
            Image(iconRes('chart')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('下载统计').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
          }
          .width('100%')
          .padding(16)
          .scale({ x: this.pressScale('menuStats'), y: this.pressScale('menuStats') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => { this.handlePress('menuStats', event); })
          .onClick(() => { this.navStack.pushPath({ name: 'stats' }); })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 下载队列入口
          Row() {
            Image(iconRes('list')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('下载队列').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
          }
          .width('100%')
          .padding(16)
          .scale({ x: this.pressScale('menuQueue'), y: this.pressScale('menuQueue') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => { this.handlePress('menuQueue', event); })
          .onClick(() => { this.navStack.pushPath({ name: 'setting', param: 'queue' }); })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 自定义分类入口
          Row() {
            Image(iconRes('folder')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('自定义分类').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
          }
          .width('100%')
          .padding(16)
          .scale({ x: this.pressScale('menuCat'), y: this.pressScale('menuCat') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => { this.handlePress('menuCat', event); })
          .onClick(() => { this.navStack.pushPath({ name: 'setting', param: 'cat' }); })
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

        // ── 下载设置（仅在进入下载设置页时显示完整内容） ──
        if (this.mode === 'download') {
        Column() {
          Row() {
            Image(iconRes('download')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('下载设置').fontSize(15).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })
          Column() {
              // ── 下载统计入口 ──
              Row() {
                Image(iconRes('chart')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
                Text('下载统计').fontColor(this.p.text).layoutWeight(1).fontSize(15)
                Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
              }
              .width('100%')
              .padding(16)
              .onClick(() => {
                this.navStack.pushPath({ name: 'stats' });
              })

              Divider().color(this.p.border).margin({ left: 16, right: 16 })

              Row() {
                Image(iconRes('cpu')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
                Text('最大线程数').fontColor(this.p.text).layoutWeight(1).fontSize(15)
                Text(String(this.vm.maxSegments)).fontColor(this.p.primaryDark).fontSize(15)
              }
              .width('100%')
              .padding({ left: 16, right: 16, top: 14, bottom: 6 })

              Slider({
                value: this.vm.maxSegments,
                min: 1,
                max: 32,
                step: 1,
                style: SliderStyle.OutSet
              })
                .onChange((v: number) => {
                  this.vm.setMaxSegments(v);
                })
                .width('100%')
                .padding({ left: 12, right: 12, bottom: 8 })
            .blockColor(this.p.primary).selectedColor(this.p.primary)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('shield_check')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('校验完整性').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.verifyIntegrity, type: ToggleType.Switch }).selectedColor(this.p.primarySolid)
              .onChange((v: boolean) => {
                this.vm.setVerify(v);
              })
          }
          .width('100%')
          .padding(16)

          // 全局限速
          Row() {
            Image(iconRes('gauge')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('全局限速').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Text(this.vm.globalSpeedLimit > 0 ? formatSpeed(this.vm.globalSpeedLimit) : '不限')
              .fontColor(this.p.primaryDark).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 6 })

          Slider({
            value: this.vm.globalSpeedLimit > 0 ? Math.log10(this.vm.globalSpeedLimit / 1024) : 0,
            min: 0,
            max: 4,
            step: 0.1,
            style: SliderStyle.OutSet
          })
            .onChange((v: number) => {
              this.vm.setGlobalSpeedLimit(v > 0 ? Math.round(Math.pow(10, v) * 1024) : 0);
            })
            .width('100%')
            .padding({ left: 12, right: 12, bottom: 8 })
            .blockColor(this.p.primary).selectedColor(this.p.primary)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // ── 下载策略（失败重试 / 文件策略 / 服务器时间） ──
          Row() {
            Image(iconRes('retry')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('失败自动重试').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Text(`${this.vm.autoRetryCount} 次`)
              .fontColor(this.p.primaryDark).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 6 })

          Row() {
            Text('重试次数 (0=关闭)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
            TextInput({ text: this.retryCountDraft, placeholder: String(this.vm.autoRetryCount) }).caretColor(this.p.primary)
              .type(InputType.Number)
              .fontSize(13)
              .fontColor(this.p.text)
              .width(80)
              .height(32)
              .backgroundColor(Color.Transparent)
              .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
              .borderRadius(6)
              .onChange((v: string) => { this.retryCountDraft = v; })
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 4 })

          Row() {
            Text('重试间隔 (秒)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
            TextInput({ text: this.retryDelayDraft, placeholder: String(this.vm.autoRetryDelaySec) }).caretColor(this.p.primary)
              .type(InputType.Number)
              .fontSize(13)
              .fontColor(this.p.text)
              .width(80)
              .height(32)
              .backgroundColor(Color.Transparent)
              .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
              .borderRadius(6)
              .onChange((v: string) => { this.retryDelayDraft = v; })
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 6 })

          Row() {
            Text('保存').fontSize(13).fontColor(this.p.primary)
              .onClick(() => {
                const c = parseInt(this.retryCountDraft, 10);
                const d = parseInt(this.retryDelayDraft, 10);
                this.vm.setAutoRetry(isNaN(c) ? this.vm.autoRetryCount : c,
                  isNaN(d) ? this.vm.autoRetryDelaySec : d);
                this.retryCountDraft = '';
                this.retryDelayDraft = '';
              })
            Blank()
            Text(`当前: ${this.vm.autoRetryCount} 次 / ${this.vm.autoRetryDelaySec}s`)
              .fontSize(11).fontColor(this.p.textSecondary)
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 10 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('file_check')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('文件已存在时').fontColor(this.p.text).layoutWeight(1).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 8 })

          Row() {
            Text('覆盖')
              .fontSize(12)
              .fontColor(this.fileExistsBehaviorLocal === 'overwrite' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileExistsBehaviorLocal === 'overwrite' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileExistsBehaviorLocal = 'overwrite'; this.vm.setFileExistsBehavior('overwrite'); })
            Text('重命名')
              .fontSize(12)
              .fontColor(this.fileExistsBehaviorLocal === 'rename' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileExistsBehaviorLocal === 'rename' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileExistsBehaviorLocal = 'rename'; this.vm.setFileExistsBehavior('rename'); })
            Text('跳过')
              .fontSize(12)
              .fontColor(this.fileExistsBehaviorLocal === 'skip' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileExistsBehaviorLocal === 'skip' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileExistsBehaviorLocal = 'skip'; this.vm.setFileExistsBehavior('skip'); })
          }
          .width('100%')
          .padding({ left: 12, right: 12, bottom: 10 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('file')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('重新检查时文件丢失').fontColor(this.p.text).layoutWeight(1).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 8 })

          Row() {
            Text('保留记录')
              .fontSize(12)
              .fontColor(this.fileMissingActionLocal === 'keep' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileMissingActionLocal === 'keep' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileMissingActionLocal = 'keep'; this.vm.setFileMissingAction('keep'); })
            Text('移除任务')
              .fontSize(12)
              .fontColor(this.fileMissingActionLocal === 'remove' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileMissingActionLocal === 'remove' ? this.p.primarySolid : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileMissingActionLocal = 'remove'; this.vm.setFileMissingAction('remove'); })
          }
          .width('100%')
          .padding({ left: 12, right: 12, bottom: 10 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('clock')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('使用服务器文件时间').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.useServerTime, type: ToggleType.Switch }).selectedColor(this.p.primarySolid)
              .onChange((v: boolean) => {
                this.vm.setUseServerTime(v);
              })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('shield_check')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Column() {
              Text('忽略 TLS 证书错误').fontColor(this.p.text).fontSize(15)
              Text('自签名/过期证书的 HTTPS 源也可下载（有安全风险）').fontColor(this.p.textSecondary).fontSize(12)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Toggle({ isOn: this.vm.ignoreTlsErrors, type: ToggleType.Switch }).selectedColor(this.p.primarySolid)
              .onChange((v: boolean) => {
                this.vm.setIgnoreTlsErrors(v);
              })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 代理
          Column() {
            Row() {
              Image(iconRes('globe')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
              Text('代理地址').fontColor(this.p.textSecondary).fontSize(13)
            }
            TextInput({ text: this.vm.proxyUrl, placeholder: 'http://host:port 或留空' }).caretColor(this.p.primary)
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .onChange((v: string) => { this.vm.setProxyUrl(v); })
              .width('100%')
              .margin({ top: 8 })
              .backgroundColor(this.p.surfaceHighlight)
              .borderRadius(8)
          }
          .width('100%')
          .padding(16)
          .alignItems(HorizontalAlign.Start)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // GitHub 镜像
          Column() {
            Row() {
              Image(iconRes('code')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
              Text('GitHub 下载加速').fontColor(this.p.textSecondary).fontSize(13)
            }
            // 预设镜像快速选择
            Select([
              { value: 'gh-proxy.com（推荐）', icon: '' },
              { value: 'mirror.ghproxy.com', icon: '' },
              { value: 'ghproxy.com', icon: '' },
              { value: 'ghfast.top', icon: '' },
              { value: '直连（不加速）', icon: '' }
            ])
              .selected(this.vm.githubMirrorUrl === '' ? 4 :
                this.vm.githubMirrorUrl === 'https://gh-proxy.com/' ? 0 :
                this.vm.githubMirrorUrl === 'https://mirror.ghproxy.com/' ? 1 :
                this.vm.githubMirrorUrl === 'https://ghproxy.com/' ? 2 :
                this.vm.githubMirrorUrl === 'https://ghfast.top/' ? 3 : 0)
              .font({ size: 14 })
              .fontColor(this.p.text)
              .selectedOptionFont({ size: 14 })
              .optionFont({ size: 14 })
              .width('100%')
              .margin({ top: 8 })
              .backgroundColor(this.p.surfaceHighlight)
              .borderRadius(8)
              .onSelect((index: number) => {
                const mirrors = ['https://gh-proxy.com/', 'https://mirror.ghproxy.com/', 'https://ghproxy.com/', 'https://ghfast.top/', ''];
                this.vm.setGithubMirrorUrl(mirrors[index]);
              })
            // 自定义输入（选择非预设时显示）
            if (!['https://gh-proxy.com/', 'https://mirror.ghproxy.com/', 'https://ghproxy.com/', 'https://ghfast.top/', ''].includes(this.vm.githubMirrorUrl)) {
              TextInput({ text: this.vm.githubMirrorUrl, placeholder: '输入自定义镜像地址' }).caretColor(this.p.primary)
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .onChange((v: string) => { this.vm.setGithubMirrorUrl(v); })
                .width('100%')
                .margin({ top: 8 })
                .backgroundColor(this.p.surfaceHighlight)
                .borderRadius(8)
            }
            Text('国内访问 GitHub 时自动通过镜像加速下载，境外链接同样支持多线程')
              .fontColor(this.p.textSecondary).fontSize(12)
              .margin({ top: 4 })
              .width('100%')
          }
          .width('100%')
          .padding(16)
          .alignItems(HorizontalAlign.Start)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 剪贴板监听
          Row() {
            Image(iconRes('clipboard')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('剪贴板监听').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.clipboardMonitor, type: ToggleType.Switch }).selectedColor(this.p.primarySolid)
              .onChange((v: boolean) => { this.vm.setClipboardMonitor(v); })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 完成通知
          Row() {
            Image(iconRes('bell')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('下载完成通知').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.notifyOnComplete, type: ToggleType.Switch }).selectedColor(this.p.primarySolid)
              .onChange((v: boolean) => { this.vm.setNotifyOnComplete(v); })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 清理失效任务
          Row() {
            Column() {
              Row() {
                Image(iconRes('trash')).width(20).height(20).fillColor(this.p.error).margin({ right: 12 })
                Text('清理失效任务').fontColor(this.p.text).fontSize(15)
              }
              Text('删除所有「错误」状态的任务（可保留文件）').fontColor(this.p.textSecondary).fontSize(12)
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            Button('清理')
              .fontSize(13)
              .backgroundColor(this.p.surfaceSolid)
              .fontColor(this.p.error)
              .onClick(() => {
                this.vm.cleanupFailed(false).then((n: number) => {
                  safeToast(this.getUIContext(), n > 0 ? `已清理 ${n} 个失效任务` : '没有失效任务' );
                });
              })
          }
          
          .padding(16)
          }
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

        // ── BT 下载（仅在进入BT下载页时显示完整内容） ──
        if (this.mode === 'bt') {
        if (this.vm.btSettings) {
          Column() {
            Row() {
              Image(iconRes('magnet'))
                .width(20)
                .height(20)
                .fillColor(this.tintColor)
                .margin({ right: 12 })
              Text('BT 下载')
                .fontSize(15)
                .fontColor(this.p.text)
                .layoutWeight(1)
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 16, bottom: 16 })

            Divider().color(this.p.border).margin({ left: 16, right: 16 })
            Column() {
            Row() {
              Text('启用 DHT').fontColor(this.p.text).layoutWeight(1).fontSize(15)
              Toggle({ type: ToggleType.Switch, isOn: this.vm.btSettings.enableDht }).selectedColor(this.p.primarySolid)
                .onChange((on: boolean) => {
                  if (this.vm.btSettings) {
                    this.vm.btSettings.enableDht = on;
                    this.vm.saveBtSettings();
                  }
                })
            }
            .width('100%')
            .padding({ top: 2, bottom: 2 })
            Text('无 Tracker 时也能通过 DHT 网络发现其它做种者').fontSize(12).fontColor(this.p.textSecondary)

            Divider().color(this.p.border).margin({ top: 8, bottom: 8 })

            Row() {
              Text('启用 UPnP').fontColor(this.p.text).layoutWeight(1).fontSize(15)
              Toggle({ type: ToggleType.Switch, isOn: this.vm.btSettings.enableUpnp }).selectedColor(this.p.primarySolid)
                .onChange((on: boolean) => {
                  if (this.vm.btSettings) {
                    this.vm.btSettings.enableUpnp = on;
                    this.vm.saveBtSettings();
                  }
                })
            }
            .width('100%')
            .padding({ top: 2, bottom: 2 })
            Text('自动映射路由器端口，提高外网可连接性').fontSize(12).fontColor(this.p.textSecondary)

            Divider().color(this.p.border).margin({ top: 8, bottom: 8 })

            Row() {
              Text('监听端口范围').fontColor(this.p.text).layoutWeight(1).fontSize(15)
              TextInput({ text: this.btPortStartDraft, placeholder: String(this.vm.btSettings.listenPortStart) }).caretColor(this.p.primary)
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btPortStartDraft = v; })
              Text('—').fontColor(this.p.textSecondary).fontSize(13).margin({ left: 4, right: 4 })
              TextInput({ text: this.btPortEndDraft, placeholder: String(this.vm.btSettings.listenPortEnd) }).caretColor(this.p.primary)
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btPortEndDraft = v; })
            }
            .width('100%')

            Divider().color(this.p.border).margin({ top: 8, bottom: 8 })

            Row() {
              Text('完成后自动做种').fontColor(this.p.text).layoutWeight(1).fontSize(15)
              Toggle({ type: ToggleType.Switch, isOn: this.vm.btSettings.seedEnabled }).selectedColor(this.p.primarySolid)
                .onChange((on: boolean) => {
                  if (this.vm.btSettings) {
                    this.vm.btSettings.seedEnabled = on;
                    this.vm.saveBtSettings();
                  }
                })
            }
            .width('100%')

            Divider().color(this.p.border).margin({ top: 8, bottom: 8 })

            Row() {
              Text('启动时自动做种').fontColor(this.p.text).layoutWeight(1).fontSize(15)
              Toggle({ type: ToggleType.Switch, isOn: this.vm.btSettings.autoReseed }).selectedColor(this.p.primarySolid)
                .onChange((on: boolean) => {
                  if (this.vm.btSettings) {
                    this.vm.btSettings.autoReseed = on;
                    this.vm.saveBtSettings();
                  }
                })
            }
            .width('100%')

            Divider().color(this.p.border).margin({ top: 8, bottom: 8 })

            Text('做种停止条件（0 = 不限制）').fontSize(12).fontColor(this.p.textSecondary).margin({ bottom: 6 })

            Row() {
              Text('总分享率').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btRatioDraft, placeholder: String(this.vm.btSettings.limits.ratioLimit) }).caretColor(this.p.primary)
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btRatioDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 6 })

            Row() {
              Text('做种时长 (小时)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btTimeDraft, placeholder: String(Math.round(this.vm.btSettings.limits.timeLimitSec / 3600)) }).caretColor(this.p.primary)
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btTimeDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 6 })

            Row() {
              Text('不活跃停止 (分钟)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btInactiveDraft, placeholder: String(Math.round(this.vm.btSettings.limits.inactiveTimeSec / 60)) }).caretColor(this.p.primary)
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btInactiveDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 6 })

            Row() {
              Text('上传限速 (KB/s)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btUploadDraft, placeholder: String(Math.round(this.vm.btSettings.limits.uploadLimit / 1024)) }).caretColor(this.p.primary)
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btUploadDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 6 })

            Row() {
              Text('同时做种数').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btMaxActiveDraft, placeholder: String(this.vm.btSettings.limits.maxActive) }).caretColor(this.p.primary)
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btMaxActiveDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 8 })

            Row() {
              Text('条件组合').fontSize(12).fontColor(this.p.textSecondary)
              Blank()
              Text('满足任一')
                .fontSize(12)
                .fontColor(this.btOperatorLocal === 'or' ? this.p.onPrimary : this.p.textSecondary)
                .backgroundColor(this.btOperatorLocal === 'or' ? this.p.primarySolid : this.p.surfaceHighlight)
                .borderRadius(14)
                .padding({ left: 12, right: 12, top: 5, bottom: 5 })
                .margin({ right: 8 })
                .onClick(() => {
                  this.btOperatorLocal = 'or';
                  if (this.vm.btSettings) {
                    this.vm.btSettings.limits.operator = SeedConditionOperator.OR;
                    this.vm.saveBtSettings();
                  }
                })
              Text('全部满足')
                .fontSize(12)
                .fontColor(this.btOperatorLocal === 'and' ? this.p.onPrimary : this.p.textSecondary)
                .backgroundColor(this.btOperatorLocal === 'and' ? this.p.primarySolid : this.p.surfaceHighlight)
                .borderRadius(14)
                .padding({ left: 12, right: 12, top: 5, bottom: 5 })
                .margin({ right: 8 })
                .onClick(() => {
                  this.btOperatorLocal = 'and';
                  if (this.vm.btSettings) {
                    this.vm.btSettings.limits.operator = SeedConditionOperator.AND;
                    this.vm.saveBtSettings();
                  }
                })
            }
            .width('100%')
            .margin({ bottom: 10 })

            Button('保存 BT 设置')
              .fontSize(14)
              .backgroundColor(this.p.primarySolid)
              .fontColor(this.p.onPrimary)
              .width('100%')
              .onClick(() => {
                const s = this.vm.btSettings;
                if (!s) return;
                const st = parseInt(this.btPortStartDraft, 10);
                const en = parseInt(this.btPortEndDraft, 10);
                if (!isNaN(st) && st >= 1 && st <= 65535) s.listenPortStart = st;
                if (!isNaN(en) && en >= 1 && en <= 65535 && en >= s.listenPortStart) s.listenPortEnd = en;
                const ratio = parseFloat(this.btRatioDraft);
                if (!isNaN(ratio) && ratio >= 0) s.limits.ratioLimit = ratio;
                const hours = parseInt(this.btTimeDraft, 10);
                if (!isNaN(hours) && hours >= 0) s.limits.timeLimitSec = hours * 3600;
                const inactive = parseInt(this.btInactiveDraft, 10);
                if (!isNaN(inactive) && inactive >= 0) s.limits.inactiveTimeSec = inactive * 60;
                const up = parseInt(this.btUploadDraft, 10);
                if (!isNaN(up) && up >= 0) s.limits.uploadLimit = up * 1024;
                const maxAct = parseInt(this.btMaxActiveDraft, 10);
                if (!isNaN(maxAct) && maxAct >= 0) s.limits.maxActive = maxAct;
                this.btPortStartDraft = '';
                this.btPortEndDraft = '';
                this.btRatioDraft = '';
                this.btTimeDraft = '';
                this.btInactiveDraft = '';
                this.btUploadDraft = '';
                this.btMaxActiveDraft = '';
                this.vm.saveBtSettings();
                safeToast(this.getUIContext(), 'BT 设置已保存' );
              })
              .padding({ left: 16, right: 16, bottom: 12 })
            }
            .padding({ left: 16, right: 16 })
          }
          .backgroundColor(this.p.surface)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(RADIUS_CARD)
          .margin({ left: 16, right: 16, top: 12 })
        }
        }

        // ── 服务（合并卡片：MCP+浏览器扩展+RSS，仅设置首页显示） ──
        if (this.mode === '') {
        Column() {
          Row() {
            Image(iconRes('server')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('服务').fontSize(15).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // MCP服务入口
          Row() {
            Image(iconRes('terminal')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('MCP 服务').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
          }
          .width('100%')
          .padding(16)
          .scale({ x: this.pressScale('menuMcp'), y: this.pressScale('menuMcp') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => { this.handlePress('menuMcp', event); })
          .onClick(() => { this.navStack.pushPath({ name: 'setting', param: 'mcp' }); })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 浏览器扩展入口
          Row() {
            Image(iconRes('link')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('浏览器扩展').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
          }
          .width('100%')
          .padding(16)
          .scale({ x: this.pressScale('menuExt'), y: this.pressScale('menuExt') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => { this.handlePress('menuExt', event); })
          .onClick(() => { this.navStack.pushPath({ name: 'setting', param: 'ext' }); })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // RSS订阅入口
          Row() {
            Image($r('app.media.ic_rss')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('RSS 订阅').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
          }
          .width('100%')
          .padding(16)
          .scale({ x: this.pressScale('menuRss'), y: this.pressScale('menuRss') })
          .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
          .onTouch((event: TouchEvent) => { this.handlePress('menuRss', event); })
          .onClick(() => { this.navStack.pushPath({ name: 'setting', param: 'rss' }); })
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

        // ── MCP 服务（仅在进入MCP页时显示完整内容） ──
        if (this.mode === 'mcp') {
        Column() {
          Row() {
            Image(iconRes('server')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('MCP 服务').fontSize(15).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })
          Column() {
              Row() {
                Column() {
                  Row() {
                    Image(iconRes('terminal')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
                    Text('MCP 本地服务').fontColor(this.p.text).fontSize(15)
                  }
                  Text('127.0.0.1:17800').fontColor(this.p.textSecondary).fontSize(12).margin({ top: 2 })
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                Toggle({ isOn: this.vm.mcpEnabled, type: ToggleType.Switch }).selectedColor(this.p.primarySolid)
                  .onChange((v: boolean) => {
                    this.vm.setMcp(v);
                  })
              }
              .width('100%')
              .padding(16)

              Divider().color(this.p.border).margin({ left: 16, right: 16 })

              Column() {
                Row() {
                  Image(iconRes('lock')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
                  Text('Bearer Token').fontColor(this.p.textSecondary).fontSize(13)
                }
                TextInput({ text: this.vm.mcpToken }).caretColor(this.p.primary)
                  .fontColor(this.p.text)
                  .onChange((v: string) => {
                    this.vm.setMcpToken(v);
                  })
                  .width('100%')
                  .margin({ top: 8 })
                  .backgroundColor(this.p.surfaceHighlight)
                  .borderRadius(8)
              }
              .width('100%')
              .padding(16)
              .alignItems(HorizontalAlign.Start)
            }
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

        // ── 浏览器扩展（仅在进入扩展页时显示完整内容） ──
        if (this.mode === 'ext') {
        Column() {
          Row() {
            Image(iconRes('link')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('浏览器扩展').fontSize(15).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('link')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('深度链接协议').fontColor(this.p.textSecondary).fontSize(13).layoutWeight(1)
            Text('fluxdown://').fontColor(this.p.primary).fontSize(13).fontFamily('monospace')
          }
          .width('100%')
          .padding({ left: 16, top: 14, bottom: 8 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Column() {
              Text('安装方式').fontColor(this.p.text).fontSize(15)
              Text('在浏览器打开 chrome://extensions，开启「开发者模式」，点击「加载已解压的扩展程序」并选择 browser-extension 目录')
                .fontColor(this.p.textSecondary).fontSize(12).margin({ top: 6 })
            }
            .alignItems(HorizontalAlign.Start).layoutWeight(1)
          }
          .width('100%')
          .padding(16)
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

        // ── 下载队列（仅在进入队列页时显示完整内容） ──
        if (this.mode === 'queue') {
        Column() {
          Row() {
            Image(iconRes('list')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('下载队列').fontSize(15).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          if (this.vm.queues.length > 0) {
            Divider().color(this.p.border).margin({ left: 16, right: 16 })
          }

          ForEach(this.vm.queues, (q: DownloadQueue) => {
            Column() {
              Row() {
                Text(q.name).fontSize(15).fontColor(this.p.text).layoutWeight(1)
                Text(`${q.taskIds.length} 任务 · ${q.maxConcurrent} 并发`)
                  .fontSize(11).fontColor(this.p.textSecondary)
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 10, bottom: 4 })

              Row() {
                Image(iconRes('play')).width(14).height(14).fillColor(this.tintColor).margin({ right: 12 })
                Text('自动开始').fontSize(13).fontColor(this.p.textSecondary).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: q.autoStart }).selectedColor(this.p.primarySolid)
                  .onChange((on: boolean) => {
                    q.autoStart = on;
                    this.vm.queueStoreUpdate(q);
                  })
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 2, bottom: 2 })

              Row() {
                Image(iconRes('timer')).width(14).height(14).fillColor(this.tintColor).margin({ right: 12 })
                Text('每日限时').fontSize(13).fontColor(this.p.textSecondary).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: q.scheduledEnabled }).selectedColor(this.p.primarySolid)
                  .onChange((on: boolean) => {
                    this.vm.setQueueSchedule(q.id, on, q.startAt, q.stopAt);
                  })
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 2, bottom: 2 })

              if (q.scheduledEnabled) {
                Row() {
                  Text(`窗口: ${this.minToTime(q.startAt)} – ${this.minToTime(q.stopAt)}`)
                    .fontSize(12).fontColor(this.p.primaryDark).layoutWeight(1)
                }
                .width('100%')
                .padding({ left: 12, right: 12, top: 2, bottom: 2 })
                Row() {
                  Text('开始').fontSize(12).fontColor(this.p.textSecondary)
                  TimePicker({ selected: this.timeToDate(q.startAt) })
                    .useMilitaryTime(true)
                    .width(120).height(32)
                    .onChange((d: TimePickerResult) => {
                      this.vm.setQueueSchedule(q.id, true, d.hour * 60 + d.minute, q.stopAt);
                    })
                  Text('停止').fontSize(12).fontColor(this.p.textSecondary).margin({ left: 8 })
                  TimePicker({ selected: this.timeToDate(q.stopAt) })
                    .useMilitaryTime(true)
                    .width(120).height(32)
                    .onChange((d: TimePickerResult) => {
                      this.vm.setQueueSchedule(q.id, true, q.startAt, d.hour * 60 + d.minute);
                    })
                }
                .width('100%')
                .padding({ left: 12, right: 12, bottom: 2 })
              }

              Row() {
                Image(iconRes('gauge')).width(14).height(14).fillColor(this.tintColor).margin({ right: 12 })
                Text('队列限速').fontSize(13).fontColor(this.p.textSecondary).layoutWeight(1)
                Text(q.speedLimit > 0 ? formatSpeed(q.speedLimit) : '不限')
                  .fontSize(13).fontColor(this.p.primaryDark)
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 2, bottom: 2 })

              Slider({
                value: q.speedLimit > 0 ? Math.log10(q.speedLimit / 1024) : 0,
                min: 0, max: 4, step: 0.1, style: SliderStyle.OutSet
              })
                .onChange((v: number) => {
                  this.vm.setQueueSpeedLimit(q.id, v > 0 ? Math.round(Math.pow(10, v) * 1024) : 0);
                })
                .width('100%')
                .padding({ left: 8, right: 8, bottom: 6 })
                .blockColor(this.p.primary).selectedColor(this.p.primary)

              Row() {
                Button('开始')
                  .fontSize(12).backgroundColor(this.p.successSolid).fontColor('#FFFFFF').height(30)
                  .margin({ right: 6 })
                  .onClick(() => { this.vm.startQueue(q.id); })
                Button('暂停')
                  .fontSize(12).backgroundColor(this.p.warningSolid).fontColor('#FFFFFF').height(30)
                  .margin({ right: 6 })
                  .onClick(() => { this.vm.pauseQueue(q.id); })
                Button('高级')
                  .fontSize(12).backgroundColor(this.p.surfaceHighlight).fontColor(this.p.primary).height(30)
                  .margin({ right: 6 })
                  .onClick(() => {
                    if (this.queueAdvId === q.id) {
                      this.queueAdvId = '';
                    } else {
                      this.queueAdvId = q.id;
                      this.queueSegDraft = q.segments > 0 ? String(q.segments) : '';
                      this.queueUaDraft = q.ua;
                      this.queueDirDraft = q.saveDir;
                    }
                  })
                Blank()
                Button('↑')
                  .fontSize(13).backgroundColor(this.p.surfaceHighlight).fontColor(this.p.primary).height(30)
                  .width(36).margin({ right: 6 })
                  .onClick(() => { this.vm.moveQueue(q.id, -1); })
                Button('↓')
                  .fontSize(13).backgroundColor(this.p.surfaceHighlight).fontColor(this.p.primary).height(30)
                  .width(36).margin({ right: 6 })
                  .onClick(() => { this.vm.moveQueue(q.id, 1); })
                Button('删除')
                  .fontSize(12).backgroundColor(this.p.errorSolid).fontColor('#FFFFFF').height(30)
                  .onClick(() => {
                    this.getUIContext().showAlertDialog({
                      title: '删除队列',
                    message: `确定要删除队列「${q.name}」吗？任务不会受影响。`,
                    autoCancel: true,
                    alignment: DialogAlignment.Center,
                    primaryButton: { value: '取消', action: () => {} },
                    secondaryButton: {
                      value: '删除', fontColor: this.p.error,
                      action: () => { this.vm.deleteQueue(q.id); }
                    }
                  });
                })
            }
            .width('100%')
            .padding({ left: 12, right: 12, bottom: 10 })

            if (this.queueAdvId === q.id) {
              Column() {
                Row() {
                  Text('线程数 (0=全局)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
                  TextInput({ text: this.queueSegDraft, placeholder: q.segments > 0 ? String(q.segments) : '默认' }).caretColor(this.p.primary)
                    .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(80).height(30)
                    .backgroundColor(Color.Transparent)
                    .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                    .onChange((v: string) => { this.queueSegDraft = v; })
                }
                .width('100%')
                .margin({ bottom: 8 })

                Row() {
                  Text('User-Agent').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
                }
                .width('100%')
                .margin({ bottom: 4 })
                TextInput({ text: this.queueUaDraft, placeholder: '留空 = 使用全局 UA' }).caretColor(this.p.primary)
                  .fontSize(13).fontColor(this.p.text).placeholderColor(this.p.textSecondary)
                  .backgroundColor(Color.Transparent)
                  .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                  .margin({ bottom: 8 })
                  .onChange((v: string) => { this.queueUaDraft = v; })

                Row() {
                  Text('保存目录').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
                }
                .width('100%')
                .margin({ bottom: 4 })
                TextInput({ text: this.queueDirDraft, placeholder: '留空 = 默认目录' }).caretColor(this.p.primary)
                  .fontSize(13).fontColor(this.p.text).placeholderColor(this.p.textSecondary)
                  .backgroundColor(Color.Transparent)
                  .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                  .margin({ bottom: 10 })
                  .onChange((v: string) => { this.queueDirDraft = v; })

                Button('保存队列设置')
                  .fontSize(13).backgroundColor(this.p.primarySolid).fontColor(this.p.onPrimary).width('100%').height(34)
                  .onClick(() => {
                    const seg = parseInt(this.queueSegDraft, 10);
                    if (!isNaN(seg) && seg >= 0 && seg <= 32) {
                      q.segments = seg;
                    }
                    q.ua = this.queueUaDraft.trim();
                    q.saveDir = this.queueDirDraft.trim();
                    this.vm.queueStoreUpdate(q);
                    this.queueAdvId = '';
                    safeToast(this.getUIContext(), '队列设置已保存' );
                  })
              }
              .width('100%')
              .padding({ left: 12, right: 12, bottom: 12 })
              .backgroundColor(this.p.surfaceHighlight)
              .borderRadius(10)
            }
            }
            .width('100%')
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(RADIUS_CARD)
            .padding({ top: 2, bottom: 2 })
            .margin({ top: 6 })
          }, (q: DownloadQueue) => q.id)

          // 新建队列
          Column() {
            TextInput({ text: this.newQueueName, placeholder: '新队列名称' }).caretColor(this.p.primary)
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(14)
              .onChange((v: string) => { this.newQueueName = v; })
            Button() {
              Row() {
                Image(iconRes('plus')).width(15).height(15).fillColor(this.p.onPrimary)
                Text('新建队列').fontSize(14).fontColor(this.p.onPrimary).margin({ left: 5 })
              }
              .justifyContent(FlexAlign.Center)
            }
              .backgroundColor(this.p.primarySolid)
              .width('100%')
              .margin({ top: 8 })
              .onClick(() => {
                const name = this.newQueueName.trim();
                if (name.length === 0) {
                  safeToast(this.getUIContext(), '请输入队列名称' );
                  return;
                }
                this.vm.createQueue(name, 2).then(() => {
                  this.newQueueName = '';
                  safeToast(this.getUIContext(), '已创建队列' );
                });
              })
          }
          .width('100%')
          .padding(16)
          .margin({ top: 6 })
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

        // ── 自定义分类（仅在进入分类页时显示完整内容） ──
        if (this.mode === 'cat') {
        Column() {
          Row() {
            Image(iconRes('folder')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
            Text('自定义分类').fontSize(15).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 添加分类
          Column() {
            TextInput({ text: this.catName, placeholder: '分类名称（如 视频）' }).caretColor(this.p.primary)
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(14)
              .onChange((v: string) => { this.catName = v; })
            TextInput({ text: this.catExts, placeholder: '扩展名规则，逗号分隔（如 mp4,mkv，留空=全部）' }).caretColor(this.p.primary)
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(14)
              .margin({ top: 8 })
              .onChange((v: string) => { this.catExts = v; })
            TextInput({ text: this.catDir, placeholder: '保存目录（留空=默认）' }).caretColor(this.p.primary)
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(14)
              .margin({ top: 8 })
              .onChange((v: string) => { this.catDir = v; })
            Button('添加分类')
              .fontSize(14)
              .backgroundColor(this.p.primarySolid)
              .fontColor(this.p.onPrimary)
              .width('100%')
              .margin({ top: 8 })
              .onClick(() => { this.addCategory(); })
          }
          .width('100%')
          .padding(16)
          .alignItems(HorizontalAlign.Start)

          // 分类列表
          ForEach(this.vm.categories, (cat: DownloadCategory) => {
            Column() {
              Row() {
                Image(iconRes('tag')).width(20).height(20).fillColor(this.tintColor).margin({ right: 12 })
                Text(cat.name).fontSize(16).fontColor(this.p.text).layoutWeight(1)
                Button('编辑')
                  .fontSize(12)
                  .backgroundColor(this.p.surfaceSolid)
                  .fontColor(this.p.primary)
                  .height(30)
                  .onClick(() => {
                    this.catEditId = cat.id;
                    this.catEditName = cat.name;
                    this.catEditExts = cat.extensions;
                    this.catEditDir = cat.saveDir;
                    this.catEditVisible = true;
                  })
                Button('删除')
                  .fontSize(12)
                  .backgroundColor(this.p.surfaceSolid)
                  .fontColor(this.p.error)
                  .height(30)
                  .margin({ left: 8 })
                  .onClick(() => {
                    this.getUIContext().showAlertDialog({
                    title: '删除分类',
                    message: `确定要删除分类「${cat.name}」吗？任务不会受影响。`,
                    autoCancel: true,
                    alignment: DialogAlignment.Center,
                    primaryButton: { value: '取消', action: () => {} },
                    secondaryButton: {
                      value: '删除',
                      fontColor: this.p.error,
                      action: () => { this.vm.deleteCategory(cat.id); }
                    }
                  });
                })
            }
            .width('100%')
            .padding(12)

            Text(cat.extensions ? `扩展名: ${cat.extensions}` : '匹配全部文件')
              .fontSize(12).fontColor(this.p.textSecondary)
              .padding({ left: 12, right: 12 })
              .width('100%')
            Text(cat.saveDir ? `保存目录: ${cat.saveDir}` : '保存目录: 默认')
              .fontSize(12).fontColor(this.p.textSecondary)
              .padding({ left: 12, right: 12, top: 2, bottom: 12 })
              
            }
            .width('100%')
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(RADIUS_CARD)
            .padding({ top: 2, bottom: 2 })
            .margin({ top: 6 })
          }, (cat: DownloadCategory) => cat.id)
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

        // ── RSS 订阅（仅在进入RSS页时显示完整内容） ──
        if (this.mode === 'rss') {
        Column() {
          Row() {
            Image($r('app.media.ic_rss'))
              .width(20)
              .height(20)
              .fillColor(this.tintColor)
              .margin({ right: 12 })
            Text('RSS 订阅')
              .fontSize(15)
              .fontColor(this.p.text)
              .layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })
          Column() {
              TextInput({ text: this.rssUrl, placeholder: 'RSS 订阅地址' }).caretColor(this.p.primary)
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .fontSize(14)
                .onChange((v: string) => { this.rssUrl = v; })
              TextInput({ text: this.rssName, placeholder: '名称' }).caretColor(this.p.primary)
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .fontSize(14)
                .margin({ top: 8 })
                .onChange((v: string) => { this.rssName = v; })
              TextInput({ text: this.rssFilter, placeholder: '包含关键词 (逗号分隔, 任一命中)' }).caretColor(this.p.primary)
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .fontSize(14)
                .margin({ top: 8 })
                .onChange((v: string) => { this.rssFilter = v; })
              TextInput({ text: this.rssExclude, placeholder: '排除关键词 (逗号分隔, 命中即跳过)' }).caretColor(this.p.primary)
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .fontSize(14)
                .margin({ top: 8 })
                .onChange((v: string) => { this.rssExclude = v; })
              Button('添加订阅')
                .fontSize(14)
                .backgroundColor(this.p.primarySolid)
                .fontColor(this.p.onPrimary)
                .width('100%')
                .margin({ top: 8 })
                .onClick(() => {
                  if (this.rssUrl.trim().length > 0 && this.rssName.trim().length > 0) {
                    this.vm.addRss(this.rssUrl.trim(), this.rssName.trim(), this.rssFilter.trim()).then((sub: RssSubscription) => {
                      sub.excludeFilter = this.rssExclude.trim();
                      this.vm.updateRss(sub);
                    });
                    this.rssUrl = '';
                    this.rssName = '';
                    this.rssFilter = '';
                    this.rssExclude = '';
                  }
                })
              Button('立即检查所有订阅')
                .fontSize(14)
                .backgroundColor(this.p.primarySolid)
                .fontColor(this.p.onPrimary)
                .width('100%')
                .margin({ top: 8 })
                .onClick(() => {
                  this.vm.pollRss().then((n: number) => {
                    safeToast(this.getUIContext(), `新增 ${n} 个下载` );
                  });
                })
            }
            .width('100%')
            .padding(16)
            .alignItems(HorizontalAlign.Start)

          if (this.vm.rssSubs.length > 0) {
            Divider().color(this.p.border).margin({ left: 16, right: 16 })
          }

          ForEach(this.vm.rssSubs, (sub: RssSubscription) => {
            Column() {
              Row() {
                Text(sub.name).fontSize(16).fontColor(this.p.text).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: sub.enabled }).selectedColor(this.p.primarySolid)
                  .onChange((on: boolean) => { this.vm.toggleRss(sub.id, on); })
              }
              .width('100%')
              .padding(12)

              Text(sub.url).fontSize(12).fontColor(this.p.textSecondary).maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .padding({ left: 12, right: 12 })

              Row() {
                Text(this.rssSummary(sub)).fontSize(11).fontColor(this.p.textSecondary).layoutWeight(1)
                Text(`已下载: ${sub.downloadedUrls.length}`).fontSize(11).fontColor(this.p.textSecondary)
              }
              .width('100%')
              .padding({ left: 12, right: 12, bottom: 8 })

              Row() {
                Button('编辑')
                  .fontSize(12)
                  .backgroundColor(this.p.surfaceHighlight)
                  .fontColor(this.p.primary)
                  .layoutWeight(1)
                  .height(32)
                  .onClick(() => {
                    this.rssEditTarget = sub;
                    this.rssEditInterval = String(sub.intervalMin);
                    this.rssEditAuto = sub.autoDownload;
                    this.rssEditExclude = sub.excludeFilter;
                    this.rssEditSizeMin = String(sub.sizeMinMB);
                    this.rssEditSizeMax = String(sub.sizeMaxMB);
                    this.rssEditQueueId = sub.queueId;
                    this.rssEditVisible = true;
                  })
                Button('删除')
                  .fontSize(12)
                  .backgroundColor(this.p.errorSolid)
                  .fontColor('#FFFFFF')
                  .layoutWeight(1)
                  .height(32)
                  .margin({ left: 8 })
                  .onClick(() => { this.vm.removeRss(sub.id); })
              }
              .width('100%')
              .padding({ left: 12, right: 12, bottom: 12 })
            }
            .width('100%')
            .backgroundColor(this.p.surface)
            .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
            .borderRadius(RADIUS_CARD)
            .padding({ top: 2, bottom: 2 })
            .margin({ top: 8 })
          })
        }
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        }

      }
      .width('100%')
      .justifyContent(FlexAlign.Start)
      .alignItems(HorizontalAlign.Start)
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .contentStartOffset(this.mode === '' ? this.statusBarHeight + 56 + 10 : 8)
    .contentEndOffset(this.mode === '' ? (this.naviIndicatorHeight + 52 + 10 + 18) : (this.naviIndicatorHeight + 52 + 16 + 16))
    .edgeEffect(EdgeEffect.Spring)
    .align(Alignment.TopStart)

      // ── 分类编辑覆盖层 ──
      if (this.catEditVisible) {
        this.CategoryEditOverlay()
      }
      // ── RSS 编辑覆盖层 ──
      if (this.rssEditVisible) {
        this.RssEditOverlay()
      }
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Bottom)
  }

  private rssSummary(sub: RssSubscription): string {
    const parts: string[] = [];
    if (sub.filter) {
      parts.push(`含:${sub.filter}`);
    }
    if (sub.excludeFilter) {
      parts.push(`排:${sub.excludeFilter}`);
    }
    if (sub.sizeMinMB > 0 || sub.sizeMaxMB > 0) {
      parts.push(`体积:${sub.sizeMinMB > 0 ? sub.sizeMinMB : '?'}-${sub.sizeMaxMB > 0 ? sub.sizeMaxMB : '∞'}MB`);
    }
    if (sub.queueId) {
      const q = this.vm.listQueues().find((x: DownloadQueue) => x.id === sub.queueId);
      parts.push(`队列:${q ? q.name : '未知'}`);
    }
    parts.push(`间隔:${sub.intervalMin}min`);
    parts.push(sub.autoDownload ? '自动下载' : '仅提醒');
    return parts.length > 0 ? parts.join(' · ') : '无过滤';
  }

  @Builder
  RssEditOverlay() {
    Column() {
      Row() {
        Text('编辑 RSS 订阅').fontSize(17).fontWeight(FontWeight.Bold).fontColor(this.p.text)
        Blank()
        Image(iconRes('x'))
          .width(20).height(20).fillColor(this.p.textSecondary)
          .onClick(() => { this.rssEditVisible = false; })
      }
      .width('100%')
      .margin({ bottom: 14 })

      Row() {
        Text('检查间隔 (分钟)').fontSize(13).fontColor(this.p.text).layoutWeight(1)
        TextInput({ text: this.rssEditInterval, placeholder: '30' }).caretColor(this.p.primary)
          .type(InputType.Number)
          .fontSize(13)
          .fontColor(this.p.text)
          .width(90)
          .height(34)
          .backgroundColor(this.p.surfaceHighlight)
          .borderRadius(6)
          .onChange((v: string) => { this.rssEditInterval = v; })
      }
      .width('100%')
      .margin({ bottom: 10 })

      Row() {
        Text('自动下载匹配条目').fontSize(13).fontColor(this.p.text).layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.rssEditAuto }).selectedColor(this.p.primarySolid)
          .onChange((on: boolean) => { this.rssEditAuto = on; })
      }
      .width('100%')
      .margin({ bottom: 10 })

      Text('排除关键词 (逗号分隔)').fontSize(13).fontColor(this.p.text).margin({ bottom: 6 })
      TextInput({ text: this.rssEditExclude, placeholder: '命中即跳过' }).caretColor(this.p.primary)
        .fontSize(13)
        .fontColor(this.p.text)
        .placeholderColor(this.p.textSecondary)
        .backgroundColor(this.p.surfaceHighlight)
        .borderRadius(6)
        .height(34)
        .margin({ bottom: 10 })
        .onChange((v: string) => { this.rssEditExclude = v; })

      Row() {
        Column() {
          Text('最小体积 (MB)').fontSize(12).fontColor(this.p.textSecondary)
          TextInput({ text: this.rssEditSizeMin, placeholder: '0 = 不限' }).caretColor(this.p.primary)
            .type(InputType.Number)
            .fontSize(13)
            .fontColor(this.p.text)
            .backgroundColor(this.p.surfaceHighlight)
            .borderRadius(6)
            .height(34)
            .margin({ top: 4 })
            .onChange((v: string) => { this.rssEditSizeMin = v; })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ right: 8 })
        Column() {
          Text('最大体积 (MB)').fontSize(12).fontColor(this.p.textSecondary)
          TextInput({ text: this.rssEditSizeMax, placeholder: '0 = 不限' }).caretColor(this.p.primary)
            .type(InputType.Number)
            .fontSize(13)
            .fontColor(this.p.text)
            .backgroundColor(this.p.surfaceHighlight)
            .borderRadius(6)
            .height(34)
            .margin({ top: 4 })
            .onChange((v: string) => { this.rssEditSizeMax = v; })
        }
        .layoutWeight(1)
      }
      .width('100%')
      .margin({ bottom: 10 })

      Text('目标队列').fontSize(13).fontColor(this.p.text).margin({ bottom: 6 })
      Scroll() {
        Row() {
          this.QueueChip('默认队列', '')
          ForEach(this.vm.listQueues(), (q: DownloadQueue) => {
            this.QueueChip(q.name, q.id)
          })
        }
        .padding({ bottom: 2 })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .margin({ bottom: 14 })

      Row() {
        Button('取消')
          .fontSize(14)
          .backgroundColor(this.p.surfaceHighlight)
          .fontColor(this.p.text)
          .layoutWeight(1)
          .height(40)
          .onClick(() => { this.rssEditVisible = false; })
        Button('保存')
          .fontSize(14)
          .backgroundColor(this.p.primarySolid)
          .fontColor(this.p.onPrimary)
          .layoutWeight(1)
          .height(40)
          .margin({ left: 10 })
          .onClick(() => {
            const sub = this.rssEditTarget;
            if (sub) {
              const iv = parseInt(this.rssEditInterval, 10);
              if (!isNaN(iv) && iv > 0) {
                sub.intervalMin = iv;
              }
              sub.autoDownload = this.rssEditAuto;
              sub.excludeFilter = this.rssEditExclude.trim();
              const min = parseInt(this.rssEditSizeMin, 10);
              const max = parseInt(this.rssEditSizeMax, 10);
              sub.sizeMinMB = isNaN(min) || min < 0 ? 0 : min;
              sub.sizeMaxMB = isNaN(max) || max < 0 ? 0 : max;
              sub.queueId = this.rssEditQueueId;
              this.vm.updateRss(sub);
            }
            this.rssEditVisible = false;
          })
      }
      .width('100%')
    }
    .width('90%')
    .padding(18)
    .backgroundColor(this.p.surface)
    .borderRadius(RADIUS_SHEET)
    .shadow(softShadow(this.p.dark, true))
    .position({ x: '5%', y: '18%' })
    .zIndex(10)
  }

  @Builder
  QueueChip(label: string, id: string) {
    Text(label)
      .fontSize(12)
      .fontColor(this.rssEditQueueId === id ? this.p.onPrimary : this.p.textSecondary)
      .backgroundColor(this.rssEditQueueId === id ? this.p.primarySolid : this.p.surfaceHighlight)
      .borderRadius(14)
      .padding({ left: 12, right: 12, top: 5, bottom: 5 })
      .margin({ right: 6 })
      .onClick(() => { this.rssEditQueueId = id; })
  }

  @Builder
  ThemeChip(label: string, mode: 'light' | 'dark' | 'system') {
    Text(label)
      .fontSize(12)
      .fontColor(this.vm.themeMode === mode ? this.p.onPrimary : this.p.textSecondary)
      .backgroundColor(this.vm.themeMode === mode ? this.p.primarySolid : this.p.surfaceHighlight)
      .borderRadius(14)
      .padding({ left: 12, right: 12, top: 5, bottom: 5 })
      .margin({ right: 8 })
      .onClick(() => {
        this.vm.setThemeMode(mode);
        // 同步应用级颜色模式，让 HDS 组件/系统毛玻璃跟随，避免手动切深色时底部导航留白
        applyAppColorMode(this.getUIContext().getHostContext() as common.UIAbilityContext, mode);
        if (mode !== 'system') {
          this.vm.setTheme(mode);
          this.applyWindowAppearance(mode === 'dark');
        } else {
          this.updateSystemTheme();
        }
      })
  }

  @Builder
  PolicyChip(label: string, value: string, current: string, onPick: (v: string) => void) {
    Text(label)
      .fontSize(12)
      .fontColor(current === value ? this.p.onPrimary : this.p.textSecondary)
      .backgroundColor(current === value ? this.p.primarySolid : this.p.surfaceHighlight)
      .borderRadius(14)
      .padding({ left: 12, right: 12, top: 5, bottom: 5 })
      .margin({ right: 8 })
      .onClick(() => { onPick(value); })
  }

  @Builder
  CategoryEditOverlay() {
    Column() {
      Blank()
      Column() {
        Text('编辑分类').fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        TextInput({ text: this.catEditName, placeholder: '分类名称' }).caretColor(this.p.primary)
          .fontSize(14).fontColor(this.p.text).placeholderColor(this.p.textSecondary)
          .backgroundColor(this.p.surfaceHighlight).borderRadius(8).width('100%').margin({ top: 16 })
          .onChange((v: string) => { this.catEditName = v; })
        TextInput({ text: this.catEditExts, placeholder: '扩展名，逗号分隔（留空=全部）' }).caretColor(this.p.primary)
          .fontSize(14).fontColor(this.p.text).placeholderColor(this.p.textSecondary)
          .backgroundColor(this.p.surfaceHighlight).borderRadius(8).width('100%').margin({ top: 8 })
          .onChange((v: string) => { this.catEditExts = v; })
        TextInput({ text: this.catEditDir, placeholder: '保存目录（留空=默认）' }).caretColor(this.p.primary)
          .fontSize(14).fontColor(this.p.text).placeholderColor(this.p.textSecondary)
          .backgroundColor(this.p.surfaceHighlight).borderRadius(8).width('100%').margin({ top: 8 })
          .onChange((v: string) => { this.catEditDir = v; })
        Row() {
          Button('取消')
            .type(ButtonType.Capsule).fontSize(14)
            .backgroundColor(this.p.surfaceSolid).fontColor(this.p.textSecondary)
            .layoutWeight(1).margin({ right: 8 })
            .onClick(() => { this.catEditVisible = false; })
          Button('保存')
            .type(ButtonType.Capsule).fontSize(14)
            .backgroundColor(this.p.primarySolid).fontColor(this.p.onPrimary)
            .layoutWeight(1).margin({ left: 8 })
            .onClick(() => { this.saveCategoryEdit(); })
        }
        .width('100%')
        .margin({ top: 16 })
      }
      .padding(20)
      .width('86%')
      .backgroundColor(this.p.surfaceSolid)
      .borderRadius(RADIUS_SHEET)
      .shadow(softShadow(this.p.dark, true))
      Blank()
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#66000000')
    .position({ x: 0, y: 0 })
  }
}

// ── 开源致谢 ──

/**
 * 单个开源致谢条目。
 * 字段按华为应用市场对第三方开源组件的披露要求组织：
 * 组件名称 / 版本 / 使用方式 / 版权所有 / 许可证（SPDX 标识）/ 源代码获取地址。
 */
interface OssAttribution {
  name: string; // 开源组件名称
  version: string; // 版本，无明确版本时填分支或 commit
  role: string; // 在本项目中的使用方式
  author: string; // 版权所有者
  license: string; // 许可证（SPDX 标识）
  repoUrl: string; // 源代码获取地址（可点击访问）
  avatarUrl: string; // 版权所有者头像网络地址，留空则用首字母占位
}

/**
 * 开源致谢清单。
 * 名称、版本、版权所有者与许可证均以仓库根目录 NOTICE 文件的声明为准。
 *
 * OpenAuthenticator 上游实际采用 GPL-3.0（NOTICE 早期误写为 MIT，已更正）。
 * 但本项目仅参考其设计系统与交互规范，未复制其源代码（上游为 Dart/Flutter，
 * 无法直接复用于 ArkTS），故不涉及 GPL-3.0 的代码级义务，此处列示仅为来源标注。
 */
const OSS_ATTRIBUTIONS: OssAttribution[] = [
  {
    name: 'FluxDown',
    version: '0.4.7',
    role: '上游原作品（Rust + Flutter），本项目为其衍生作品',
    author: 'zerx-lab 及 FluxDown contributors',
    license: 'AGPL-3.0',
    repoUrl: 'https://github.com/zerx-lab/FluxDown',
    avatarUrl: 'https://github.com/zerx-lab.png'
  },
  {
    name: 'OpenAuthenticator',
    version: 'main 分支',
    role: '界面与交互设计参考（未使用其源代码）',
    author: 'OpenAuthenticator contributors',
    license: 'GPL-3.0',
    repoUrl: 'https://github.com/openauthenticator-app/openauthenticator',
    avatarUrl: 'https://github.com/openauthenticator-app.png'
  },
  {
    name: '@tangs/components',
    version: '1.5.3',
    role: '界面组件库（药丸式滚动标签栏、沉浸按钮 / 搜索栏等）',
    author: '汤于艺',
    license: 'Apache-2.0',
    repoUrl: 'https://gitcode.com/tangs_2003/components',
    avatarUrl: ''
  }
];

