import { promptAction, LengthMetrics, curves } from '@kit.ArkUI';
import { HdsTabs, HdsTabsController, HdsTabsFloatingStyle, HdsBarStyle, HdsTabsBarChangeMode, hdsMaterial, SystemMaterialParams, HdsNavigation, HdsNavigationTitleMode, HdsNavigationMenuContentOptions, ScrollEffectType, BlurStrategy } from '@kit.UIDesignKit';
import { ImmersionButton, ImmersionSearch } from '@tangs/components';
import { ButtonModifier } from '@kit.ArkUI';
import { window } from '@kit.ArkUI';
import { common, Want, OpenLinkOptions, ConfigurationConstant } from '@kit.AbilityKit';
import bundleManager from '@ohos.bundle.bundleManager';
import { picker, fileUri } from '@kit.CoreFileKit';
import { wantConstant } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { pasteboard } from '@kit.BasicServicesKit';
import pasteboardSys from '@ohos.pasteboard';
import fs from '@ohos.file.fs';

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

// ───────────────────────── 统一质感设计 token（P0） ─────────────────────────
// 卡片/控件按压缩放比例与时长：全局统一的物理按压反馈（阻尼曲线）
const PRESS_SCALE: number = 0.97;
const PRESS_SCALE_STRONG: number = 0.92;
const PRESS_DURATION: number = 160;
// 统一圆角层级：卡片 14、弹层/子页面 18
const RADIUS_CARD: number = 14;
const RADIUS_SHEET: number = 18;
// 弹层进场/退场时长（由 450ms 收敛，克制不拖沓）
const SHEET_OPEN_DURATION: number = 300;
const SHEET_CLOSE_DURATION: number = 200;
// P1 材质：毛玻璃模糊档位与 0.5px 描边（参考 OpenAuthenticator 材质系统）
const MATERIAL_BLUR: BlurStyle = BlurStyle.COMPONENT_THIN;
const MATERIAL_BORDER_WIDTH: number = 0.5;

/** 毛玻璃描边色：暗色模式半透明白、浅色模式半透明黑（极淡，只勾勒边缘） */
function materialBorder(dark: boolean): string {
  return dark ? '#26FFFFFF' : '#14000000';
}

/** 全局系统材质效果（用于 ImmersionButton/ImmersionSearch，参考 OpenAuthenticator 默认 ADAPTIVE） */
function globalMaterialEffect(): SystemMaterialParams {
  return {
    materialType: hdsMaterial.MaterialType.ADAPTIVE,
    materialLevel: hdsMaterial.MaterialLevel.ADAPTIVE
  };
}

/** 按钮修饰器（参考对比项目 ActionButtonModifier，通过 buttonModify 设置内部宽度） */
class ActionButtonModifier implements AttributeModifier<ButtonModifier> {
  private buttonWidth: Length;
  private buttonHeight: number;

  constructor(buttonWidth: Length, buttonHeight: number) {
    this.buttonWidth = buttonWidth;
    this.buttonHeight = buttonHeight;
  }

  applyNormalAttribute(instance: ButtonModifier): void {
    instance.width(this.buttonWidth)
      .height(this.buttonHeight);
  }
}

/** 沉浸式按钮修饰器（带文字颜色，用于 ImmersionButton 深色/浅色适配） */
class ImmersionButtonModifier implements AttributeModifier<ButtonModifier> {
  private buttonWidth: Length;
  private buttonHeight: number;
  private fontColor: string;

  constructor(buttonWidth: Length, buttonHeight: number, fontColor: string) {
    this.buttonWidth = buttonWidth;
    this.buttonHeight = buttonHeight;
    this.fontColor = fontColor;
  }

  applyNormalAttribute(instance: ButtonModifier): void {
    instance.width(this.buttonWidth)
      .height(this.buttonHeight)
      .fontColor(this.fontColor)
      .fontSize(15)
      .fontWeight(FontWeight.Medium);
  }
}

/** 给 #RRGGBB 颜色追加透明度，返回 #AARRGGBB；alpha 取 0~1 */
function withAlpha(hex: string, alpha: number): string {
  if (!hex || hex.length < 7) {
    return hex;
  }
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
    .toString(16).padStart(2, '0');
  return `#${a}${hex.substring(1)}`;
}

/** 统一柔和阴影：大半径、向下轻偏移、极低不透明度，深色模式略加深 */
function softShadow(dark: boolean, elevated: boolean = false): ShadowOptions {
  return {
    radius: elevated ? 24 : 20,
    color: dark ? (elevated ? '#40000000' : '#33000000') : (elevated ? '#1A000000' : '#14000000'),
    offsetX: 0,
    offsetY: elevated ? 10 : 8
  };
}

interface Palette {
  dark: boolean;
  bg: string;
  surface: string;
  surfaceSolid: string;
  surfaceHighlight: string;
  materialBg: string;    // 毛玻璃底色（半透明，配 backgroundBlurStyle 使用）
  text: string;
  textSecondary: string;
  primary: string;
  primaryDark: string;
  onPrimary: string;      // primary 背景上的前景色（莫兰迪浅色用深字保证对比度）
  primaryFill: string;   // 主题色 10%：浅底强调/轻填充
  primaryTint: string;   // 主题色 20%：选中浅底/高亮
  border: string;
  success: string;
  warning: string;
  error: string;
}

interface HlsVariantResult {
  urls: string[];
  labels: string[];
}

function palette(theme: 'light' | 'dark', colorSchemeId: string = 'cyan'): Palette {
  const scheme = getScheme(colorSchemeId);
  // 莫兰迪色明暗各一档；经典色缺省复用 primary
  const primary = theme === 'dark' ? (scheme.darkPrimary ?? scheme.primary) : scheme.primary;
  const onPrimary = scheme.onPrimary ?? '#FFFFFF';
  if (theme === 'dark') {
    // 对齐 OpenAuthenticator 深色体系：纯黑底 + 深灰卡片（实色，杜绝偏色）
    return {
      dark: true,
      bg: '#000000',
      surface: '#191919',
      surfaceSolid: '#232323',
      surfaceHighlight: '#2C2C2C',
      materialBg: '#E6303030',   // 深色毛玻璃底：90% 深灰，透出模糊内容
      text: '#EEEEEE',
      textSecondary: '#D0D0D0',
      primary: primary,
      primaryDark: scheme.primaryDark,
      onPrimary: onPrimary,
      primaryFill: withAlpha(primary, 0.12),
      primaryTint: withAlpha(primary, 0.22),
      border: '#444444',
      success: '#22C55E',
      warning: '#F59E0B',
      error: '#EF4444'
    };
  }
  return {
    dark: false,
    bg: '#F2F3F5',
    surface: '#FFFFFF',
    surfaceSolid: '#FFFFFF',
    surfaceHighlight: '#E9EBEF',
    materialBg: '#F7FFFFFF',   // 浅色毛玻璃底：97% 白，透出模糊内容
    text: '#1A1A1A',
    textSecondary: '#4A4A4A',
    primary: primary,
    primaryDark: scheme.primaryDark,
    onPrimary: onPrimary,
    primaryFill: withAlpha(primary, 0.10),
    primaryTint: withAlpha(primary, 0.18),
    border: '#14000000',
    success: scheme.success,
    warning: scheme.warning,
    error: scheme.error
  };
}

function statusText(s: TaskStatus): string {
  switch (s) {
    case TaskStatus.Queued:
      return '排队中';
    case TaskStatus.Downloading:
      return '下载中';
    case TaskStatus.Merging:
      return '合并中';
    case TaskStatus.Paused:
      return '已暂停';
    case TaskStatus.Verifying:
      return '校验中';
    case TaskStatus.Completed:
      return '已完成';
    case TaskStatus.Error:
      return '错误';
    default:
      return '未知';
  }
}

/** 图标查找表：Lucide 图标集（已从原应用字体提取为 SVG 资源，fill=currentColor 由 fillColor 着色）。 */
const ICON: Map<string, Resource> = new Map([
  ['download', $r('app.media.ic_download')],
  ['settings', $r('app.media.ic_settings')],
  ['rss', $r('app.media.ic_rss')],
  ['chart', $r('app.media.ic_chart_column')],
  ['grid', $r('app.media.ic_layout_grid')],
  ['file', $r('app.media.ic_file_text')],
  ['check', $r('app.media.ic_circle_check')],
  ['alert', $r('app.media.ic_alert_triangle')],
  ['clock', $r('app.media.ic_clock')],
  ['pause', $r('app.media.ic_pause')],
  ['play', $r('app.media.ic_play')],
  ['plus', $r('app.media.ic_plus')],
  ['trash', $r('app.media.ic_trash_2')],
  ['folder', $r('app.media.ic_folder')],
  ['folder_open', $r('app.media.ic_folder_open')],
  ['rename', $r('app.media.ic_square_pen')],
  ['recheck', $r('app.media.ic_refresh_cw')],
  ['retry', $r('app.media.ic_rotate_ccw')],
  ['file_check', $r('app.media.ic_file_check')],
  ['open', $r('app.media.ic_external_link')],
  ['copy', $r('app.media.ic_copy')],
  ['share', $r('app.media.ic_share_2')],
  ['x', $r('app.media.ic_x')],
  ['more', $r('app.media.ic_more_horizontal')],
  ['more_v', $r('app.media.ic_more_vertical')],
  ['search', $r('app.media.ic_search')],
  ['filter', $r('app.media.ic_filter')],
  ['chevron_down', $r('app.media.ic_chevron_down')],
  ['chevron_up', $r('app.media.ic_chevron_up')],
  ['chevron_right', $r('app.media.ic_chevron_right')],
  ['link', $r('app.media.ic_link')],
  ['magnet', $r('app.media.ic_magnet')],
  ['arrow_down', $r('app.media.ic_arrow_down_to_line')],
  ['arrow_up', $r('app.media.ic_arrow_up_from_line')],
  ['server', $r('app.media.ic_server')],
  ['cpu', $r('app.media.ic_cpu')],
  ['zap', $r('app.media.ic_zap')],
  ['wifi', $r('app.media.ic_wifi')],
  ['globe', $r('app.media.ic_globe')],
  ['shield', $r('app.media.ic_shield')],
  ['lock', $r('app.media.ic_lock')],
  ['bell', $r('app.media.ic_bell')],
  ['gauge', $r('app.media.ic_gauge')],
  ['timer', $r('app.media.ic_timer')],
  ['list', $r('app.media.ic_list')],
  ['disk', $r('app.media.ic_hard_drive')],
  ['db', $r('app.media.ic_database')],
  ['palette', $r('app.media.ic_palette')],
  ['moon', $r('app.media.ic_moon')],
  ['sun', $r('app.media.ic_sun')],
  ['info', $r('app.media.ic_info')],
  ['terminal', $r('app.media.ic_terminal_square')],
  ['sliders', $r('app.media.ic_sliders_horizontal')],
  ['save', $r('app.media.ic_save')],
  ['calendar', $r('app.media.ic_calendar')],
  ['eye', $r('app.media.ic_eye')],
  ['tag', $r('app.media.ic_tag')],
  ['folder_plus', $r('app.media.ic_folder_plus')],
  ['folder_tree', $r('app.media.ic_folder_tree')],
  ['loader', $r('app.media.ic_loader_2')],
  ['hash', $r('app.media.ic_hash')],
  ['video', $r('app.media.ic_file_video')],
  ['audio', $r('app.media.ic_file_audio')],
  ['image', $r('app.media.ic_file_image')],
  ['code', $r('app.media.ic_file_code')],
  ['archive', $r('app.media.ic_file_archive')],
  ['clipboard', $r('app.media.ic_clipboard')],
  ['pen', $r('app.media.ic_pen_line')],
  ['music', $r('app.media.ic_music')],
  ['package', $r('app.media.ic_package')],
  ['menu', $r('app.media.ic_menu')],
  ['upload', $r('app.media.ic_upload_cloud')],
  ['cloud_down', $r('app.media.ic_download_cloud')],
  ['thumbs_up', $r('app.media.ic_thumbs_up')],
  ['star', $r('app.media.ic_star')],
  ['heart', $r('app.media.ic_heart')],
  ['send', $r('app.media.ic_send')],
  ['message', $r('app.media.ic_message_square')],
  ['qq', $r('app.media.ic_qq')],
  ['shield_check', $r('app.media.ic_shield')],
  ['ban', $r('app.media.ic_shield_ban')],
  ['external', $r('app.media.ic_arrow_up_right_from_square')],
  ['drag', $r('app.media.ic_grip_vertical')],
  ['help', $r('app.media.ic_circle_help')],
  ['alert_circle', $r('app.media.ic_circle_alert')],
  ['scan', $r('app.media.ic_scan')],
  ['waypoints', $r('app.media.ic_waypoints')],
  ['network', $r('app.media.ic_network')],
  ['list_filter', $r('app.media.ic_list_filter')],
  ['list_ordered', $r('app.media.ic_list_ordered')],
  ['inbox', $r('app.media.ic_archive')],
  ['user', $r('app.media.ic_user')],
]);

function iconRes(name: string): Resource {
  const r = ICON.get(name);
  return r ?? $r('app.media.ic_download');
}

/** 协议 → Lucide 图标名 */
function protocolIcon(proto: ProtocolType): string {
  switch (proto) {
    case ProtocolType.BITTORRENT:
      return 'magnet';
    case ProtocolType.ED2K:
      return 'hash';
    case ProtocolType.HLS:
    case ProtocolType.DASH:
      return 'video';
    case ProtocolType.FTP:
    case ProtocolType.SFTP:
      return 'server';
    case ProtocolType.THUNDER:
      return 'zap';
    case ProtocolType.HTTPS:
      return 'lock';
    case ProtocolType.HTTP:
      return 'globe';
    default:
      return 'link';
  }
}

/** 任务状态 → Lucide 图标名 */
/** 协议 label → Lucide 图标名 */
function protocolLabelIcon(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('torrent') || l.includes('磁力')) {
    return 'magnet';
  }
  if (l.includes('ed2k') || l.includes('电驴')) {
    return 'hash';
  }
  if (l.includes('hls') || l.includes('dash')) {
    return 'video';
  }
  if (l.includes('ftp') || l.includes('sftp')) {
    return 'server';
  }
  if (l.includes('thunder') || l.includes('迅雷')) {
    return 'zap';
  }
  if (l.includes('https')) {
    return 'lock';
  }
  if (l.includes('http')) {
    return 'globe';
  }
  return 'link';
}

function statusIcon(s: TaskStatus): string {
  switch (s) {
    case TaskStatus.Queued:
      return 'clock';
    case TaskStatus.Downloading:
      return 'loader';
    case TaskStatus.Merging:
      return 'loader';
    case TaskStatus.Paused:
      return 'pause';
    case TaskStatus.Verifying:
      return 'shield_check';
    case TaskStatus.Completed:
      return 'check';
    case TaskStatus.Error:
      return 'alert';
    default:
      return 'file';
  }
}

/** Convert hex color (#RRGGBB) to rgba with given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

@ComponentV2
struct FilterChipComponent {
  @Param label: string = '';
  @Param selected: boolean = false;
  @Param p: Palette = palette('light');
  @Param onTap: () => void = () => {};

  build() {
    Text(this.label)
      .fontSize(14)
      .fontColor(this.selected ? this.p.onPrimary : this.p.text)
      .padding({ left: 14, right: 14, top: 8, bottom: 8 })
      .borderRadius(14)
      .backgroundColor(this.selected ? this.p.primary : this.p.surface)
      .margin({ right: 8, bottom: 8 })
      .onClick(this.onTap)
  }
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
  @Local selectMode: boolean = false;
  @Local selectedTaskIds: Set<string> = new Set();
  @Local updateInfo: ReleaseInfo | null = null;
  private deepLinkTimer: number = -1;
  // 下载中图标旋转动画
  @Local rotateAngle: number = 0;
  private rotateTimer: number = -1;
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
      const ctx = getContext(this) as common.UIAbilityContext;
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
      animateTo({
        duration: SHEET_OPEN_DURATION,
        curve: curves.cubicBezierCurve(0.3, 1.12, 0.4, 1),
      }, () => {
        this.sheetScale = 1;
        this.sheetOpacity = 1;
      });
    }, 16);
  }

  closeAddSheet(): void {
    animateTo({
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
      animateTo({
        duration: SHEET_OPEN_DURATION,
        curve: curves.cubicBezierCurve(0.3, 1.12, 0.4, 1),
      }, () => {
        this.filterSheetScale = 1;
        this.filterSheetOpacity = 1;
      });
    }, 16);
  }

  closeFilterSheet(): void {
    animateTo({
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
    // 底部安全区域高度由 EntryAbility 发布到 AppStorage，在 tabsFloatingStyle 中实时读取
    const context = getContext(this) as common.UIAbilityContext;
    this.vm.init(context).then(() => {
      // vm 初始化完成（主题、配置、数据已加载）后再渲染主界面，避免首次启动白屏
      this.pageReady = true;
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
    }, 1500);
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
          promptAction.showToast({ message: '已从浏览器扩展接收链接，开始下载' });
        }
        // pending：正在添加中，不显示 toast
      }).catch((e: Error) => {
        promptAction.showToast({ message: '链接接收失败: ' + (e?.message || String(e)) });
      });
    }
  }

  /** Apply system brightness to the active theme when "跟随系统" is selected. */
  private updateSystemTheme(): void {
    if (this.vm.themeMode !== 'system') {
      return;
    }
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const isDark = ctx.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
      const target: 'light' | 'dark' = isDark ? 'dark' : 'light';
      if (this.vm.theme !== target) {
        this.vm.setTheme(target);
      }
    } catch (e) {
      // config unavailable — keep current theme
    }
  }

  private async checkForUpdate(silent: boolean = false): Promise<void> {
    try {
      const info = await checkForUpdate(APP_VERSION, this.vm.proxyConfig(), this.vm.ignoreTlsErrors);
      if (info) {
        logCollector.info('Update', `发现新版本: ${info.version}`);
        this.updateInfo = info;
        this.showUpdateDialog();
      } else if (!silent) {
        logCollector.info('Update', '已是最新版本');
        this.showCenterToast('已是最新版本');
      }
    } catch (e) {
      logCollector.error('Update', `检查更新失败: ${JSON.stringify(e)}`);
      if (!silent) {
        this.showCenterToast('检查更新失败，请检查网络');
      }
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
    AlertDialog.show({
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
        fontColor: '#007AFF',
        action: () => {
          this.vm.confirmDuplicateDownload('redownload').then(() => {
            promptAction.showToast({ message: '已重新添加下载任务' });
          });
        }
      }
    });
  }

  private showUpdateDialog(): void {
    const info = this.updateInfo;
    if (!info) return;
    AlertDialog.show({
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
        fontColor: '#007AFF',
        action: () => {
          if (info.downloadUrl) {
            this.vm.addDownload(info.downloadUrl).then((result: 'added' | 'duplicate' | 'pending' | 'skipped') => {
              if (result === 'duplicate') {
                this.showDuplicateDialog();
                return;
              }
              if (result === 'added') {
                promptAction.showToast({ message: '已添加更新下载任务' });
                this.currentTab = 0;
              }
            }).catch((e: Error) => {
              promptAction.showToast({ message: '添加下载失败' });
            });
          } else {
            promptAction.showToast({ message: '未找到安装包下载地址' });
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
      (getContext(this) as common.UIAbilityContext).startAbility(want);
    } catch (e) {
      promptAction.showToast({ message: '打开文件失败: ' + ((e as Error)?.message || String(e)) });
    }
  }

  private async openFileLocation(task: DownloadTask): Promise<void> {
    try {
      if (!task.publicPath) {
        await this.vm.exportToDownload(task);
      }
      // Use openLink to open the system file manager at the file's directory
      const fileUriObj = fileUri.getUriFromPath(task.publicPath);
      const ctx = getContext(this) as common.UIAbilityContext;
      ctx.openLink('filemanager://openDirectory', {
        parameters: { 'fileUri': fileUriObj }
      } as OpenLinkOptions);
    } catch (e) {
      promptAction.showToast({ message: '打开文件目录失败: ' + ((e as Error)?.message || String(e)) });
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
      return '更多';
    }
    return 'FluxDown Cover';
  }

  /** HdsNavigation 右上角菜单（完全按照原项目 homeSearchMenu 方式，HdsNavigationMenuContentOptions 格式） */
  private homeSearchMenu(): HdsNavigationMenuContentOptions {
    if (this.currentMainTab === 1) {
      return { value: [], maxCount: 0 };
    }
    return {
      value: [
        {
          content: {
            icon: iconRes('search'),
            label: '搜索',
            action: () => { this.searchMode = !this.searchMode; }
          }
        },
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
      maxCount: 3
    };
  }

  @Builder
  NavigationTitle() {
    Row() {
      if (this.currentMainTab === 1) {
        // ── 我的：与下载页同款标题栏（图标 + 标题），配色一致 ──
        Image(iconRes('user'))
          .width(28).height(28).fillColor(this.p.primary)
          .margin({ left: 16, right: 10 })

        Text('更多')
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.p.text)
      } else if (this.searchMode) {
        ImmersionSearch({
          systemMaterialEffect: globalMaterialEffect(),
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
      } else {
        Image(iconRes('download'))
          .width(28).height(28).fillColor(this.p.primary)
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
    .height(this.winWidth > 600 ? 44 : 56)
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
    .height(56)
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
        .fillColor(this.currentMainTab === index ? this.p.primary : this.p.textSecondary)
        .animation({ duration: 250, curve: Curve.Smooth })
      Text(label)
        .fontSize(11)
        .fontWeight(this.currentMainTab === index ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.currentMainTab === index ? this.p.primary : this.p.textSecondary)
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
        .fillColor(this.currentMainTab === 0 ? this.p.primary : this.p.textSecondary)
      Text('下载')
        .fontSize(11)
        .margin({ top: 2 })
        .fontColor(this.currentMainTab === 0 ? this.p.primary : this.p.textSecondary)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  /** HdsTabs 我的 Tab（自定义，去掉系统矩形点击高亮） */
  @Builder
  meTabBuilder() {
    Column() {
      Image(iconRes('user'))
        .width(22).height(22)
        .fillColor(this.currentMainTab === 1 ? this.p.primary : this.p.textSecondary)
      Text('更多')
        .fontSize(11)
        .margin({ top: 2 })
        .fontColor(this.currentMainTab === 1 ? this.p.primary : this.p.textSecondary)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  /** HdsTabs 悬浮样式（参考项目 homeTabsFloatingStyle，毛玻璃悬浮导航条） */
  private tabsFloatingStyle(): HdsTabsFloatingStyle {
    // 参考对比项目：默认用 ADAPTIVE 自适应材质，深色模式自动变暗，避免偏白
    const materialEffect: SystemMaterialParams = {
      materialType: hdsMaterial.MaterialType.ADAPTIVE,
      materialLevel: hdsMaterial.MaterialLevel.ADAPTIVE
    };
    // 导航条宽度随屏幕放大：手机196，PC/平板取屏幕宽度的38%（上限420，下限196）
    const barW = this.winWidth > 600 ? Math.min(420, Math.max(196, this.winWidth * 0.38)) : 196;
    // 居中显示（加3px修正HdsTabs系统偏移）
    const sideMargin = Math.max(16, (this.winWidth - barW) / 2 + 3);
    const style: HdsTabsFloatingStyle = {
      // 完全按照原项目：实时从AppStorage读取动态底部安全区域高度
      barBottomMargin: AppStorage.get<number>('fluxdown_naviIndicatorHeight') ?? 0,
      barSideMargin: sideMargin,
      barWidth: { smallWidth: barW, mediumWidth: barW, largeWidth: barW },
      lightColor: this.p.primary,
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
            }
            .barOverlap(true)
            .vertical(false)
            .scrollable(false)
            .barPosition(BarPosition.End)
            .barWidth(this.winWidth > 600 ? Math.min(420, Math.max(196, this.winWidth * 0.38)) : 196)
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
            .backgroundColor(this.p.bg)
          }
          .width('100%')
          .height('100%')
          .backgroundColor(this.p.bg)
        } else {
          // 启动占位页（等 vm.init 完成后再渲染主界面，避免首次启动白屏）
          Column() {
            Image(iconRes('download'))
              .width(48).height(48)
              .fillColor('#007AFF')
            Text('FluxDown Cover')
              .fontSize(16)
              .fontColor('#8E8E93')
              .margin({ top: 12 })
          }
          .width('100%')
          .height('100%')
          .backgroundColor('#000000')
          .justifyContent(FlexAlign.Center)
        }
      }
      .backgroundColor(this.p.bg)
      .mode(NavigationMode.Stack)
      .titleBar({
        content: {
          title: {
            mainTitle: this.currentHomeTitle()
          },
          menu: this.homeSearchMenu()
        },
        style: {
          scrollEffectOpts: {
            enableScrollEffect: false,
            scrollEffectType: ScrollEffectType.GRADIENT_BLUR
          },
          blurStrategy: BlurStrategy.ADAPTIVE,
          originalStyle: { backgroundStyle: { backgroundColor: '#00ffffff' } },
          scrollEffectStyle: { backgroundStyle: { backgroundColor: '#00ffffff' } },
          systemMaterialEffect: {
            materialType: hdsMaterial.MaterialType.ADAPTIVE,
            materialLevel: hdsMaterial.MaterialLevel.ADAPTIVE
          }
        },
        avoidLayoutSafeArea: true,
        enableComponentSafeArea: false
      })
      .navDestination(this.NavDest)
      .hideBackButton(true)
      .titleMode(HdsNavigationTitleMode.MINI)
      .ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.TOP])
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
          .backgroundColor(this.p.materialBg)
          .backgroundBlurStyle(MATERIAL_BLUR)
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
    }
    .width('100%')
    .height('100%')
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
              AboutContent({ vm: this.vm, onCheckUpdate: () => { this.checkForUpdate(false); } })
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
      'cat': '自定义分类', 'rss': 'RSS 订阅'
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
        Image(iconRes('check')).width(18).height(18).fillColor(this.p.primary)
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
      .padding({ left: this.winWidth > 600 ? 16 : 12, right: this.winWidth > 600 ? 16 : 12, top: 8, bottom: 8 })

      if (this.vm.visibleTasks.length === 0) {
        Column({ space: 18 }) {
          Image(iconRes('download'))
            .width(88).height(88).fillColor(this.p.primary)
            .opacity(0.6)
          Text('还没有下载任务')
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.p.text)
          ImmersionButton({
            systemMaterialEffect: globalMaterialEffect(),
            text: '新建下载',
            buttonModify: new ImmersionButtonModifier(148, 44, this.p.dark ? '#FFFFFF' : '#000000'),
            click: (): void => {
              this.openAddSheet();
            }
          })
          .width(148)
          .height(44)
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
          .padding({ bottom: 88 })
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
            .backgroundColor(this.selectedTaskIds.size > 0 ? '#E8553B' : Color.Transparent)
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
        .margin({ bottom: 84 })
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
      .margin({ right: 20, bottom: 84 })
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
        TextInput({ text: draft, placeholder: placeholder })
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
            .backgroundColor(this.p.primary)
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
    .backgroundColor(this.currentTab === index ? this.p.primary : this.p.surface)
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
      .backgroundColor(this.vm.statusFilter === key ? this.p.primary : this.p.surface)
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
        .fontSize(this.winWidth > 600 ? 14 : (this.winWidth < 360 ? 10.5 : 12))
        .fontWeight(this.vm.statusFilter === key ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.vm.statusFilter === key ? this.p.primary : this.p.textSecondary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .padding({ left: this.winWidth > 600 ? 8 : 4, right: this.winWidth > 600 ? 8 : 4 })
    }
    .height(this.winWidth > 600 ? 38 : 32)
    .borderRadius(this.winWidth > 600 ? 19 : 16)
    .backgroundColor(Color.Transparent)
    .backgroundBlurStyle(MATERIAL_BLUR)
    .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
    .layoutWeight(1)
    .margin({ right: this.winWidth > 600 ? 10 : 4 })
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
                promptAction.showToast({ message: '已重新检查，可从下载列表重新开始' });
              }).catch((e: Error) => {
                promptAction.showToast({ message: '重新检查失败: ' + (e?.message || String(e)) });
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
    AlertDialog.show(
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
            fontColor: '#888888'
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
            fontColor: '#007AFF'
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
            fontColor: '#FF3B30'
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
      promptAction.showToast({ message: '已重命名' });
      this.renameDialogVisible = false;
    }).catch((e: Error) => {
      promptAction.showToast({ message: '重命名失败: ' + (e?.message || String(e)) });
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
      promptAction.showToast({ message: '已移动任务' });
      this.moveDialogVisible = false;
    }).catch((e: Error) => {
      promptAction.showToast({ message: '移动失败: ' + (e?.message || String(e)) });
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
        .backgroundColor('#FFA940')
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
        .backgroundColor('#52C41A')
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
        .backgroundColor('#007DFF')
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
      .backgroundColor('#E8553B')
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
      task.status === TaskStatus.Downloading || task.status === TaskStatus.Queued ? '#FFA940' :
      task.status === TaskStatus.Paused || task.status === TaskStatus.Error ? '#52C41A' :
      task.status === TaskStatus.Completed ? '#52C41A' : this.p.surfaceSolid
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
        if (text && text.trim().length > 0) {
          this.handleUrlInput(text.trim());
        } else {
          logCollector.warn('Pasteboard', `剪贴板无文本内容: records=${recordCount}`);
          promptAction.showToast({ message: '剪贴板中没有文本' });
        }
      }).catch((e: Error) => {
        logCollector.error('Pasteboard', `getData失败: ${JSON.stringify(e)}`);
        // 降级用同步方式
        try {
          const pasteData2 = sysPasteboard.getDataSync();
          const text2 = pasteData2.getPrimaryText() || '';
          logCollector.info('Pasteboard', `同步降级读取: ${text2?.slice(0, 80) || '(空)'}`);
          if (text2 && text2.trim().length > 0) {
            this.handleUrlInput(text2.trim());
          } else {
            promptAction.showToast({ message: '剪贴板中没有文本' });
          }
        } catch (e2) {
          logCollector.error('Pasteboard', `同步降级也失败: ${JSON.stringify(e2)}`);
          promptAction.showToast({ message: '读取剪贴板失败' });
        }
      });
    } catch (e) {
      logCollector.error('Pasteboard', `pasteFromClipboard异常: ${JSON.stringify(e)}`);
      promptAction.showToast({ message: '读取剪贴板失败' });
    }
  }

  /** Pick a .txt file and load each line as a batch download URL. */
  async importTxtLinks(): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
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
        promptAction.showToast({ message: `已导入 ${lines.length} 条链接` });
      } finally {
        fs.closeSync(file.fd);
      }
    } catch (e) {
      promptAction.showToast({ message: '导入 TXT 失败: ' + ((e as Error)?.message || String(e)) });
    }
  }

  /** Open system file picker to select a .torrent file. */
  async pickTorrentFile(): Promise<void> {    try {
      const context = getContext(this) as common.UIAbilityContext;
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
        promptAction.showToast({ message: '已选择种子文件' });
      }
    } catch (e) {
      promptAction.showToast({ message: '选择文件失败: ' + (e as Error).message });
    }
  }

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
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
    AlertDialog.show({
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
        fontColor: '#007AFF',
        action: () => {
          this.vm.confirmDuplicateDownload('redownload').then(() => {
            promptAction.showToast({ message: '已重新添加下载任务' });
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
        Image(iconRes('link')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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

        TextInput({ placeholder: '粘贴或输入下载链接，自动识别协议', text: this.url, controller: this.urlInputController })
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

        // 粘贴按钮
        Row() {
          Image(iconRes('clipboard')).width(15).height(15).fillColor(this.p.primary)
          Text('粘贴').fontSize(12).fontColor(this.p.primary).margin({ left: 4 })
        }
        .padding({ left: 10, right: 10, top: 6, bottom: 6 })
        .backgroundColor(this.p.surface)
        .borderRadius(8)
        .margin({ left: 6 })
        .onClick(() => { this.pasteFromClipboard(); })
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
                .backgroundColor(this.hlsQualityIndex === idx ? this.p.primary : this.p.surface)
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
        Image(iconRes(this.showAdvanced ? 'chevron_up' : 'chevron_down'))
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
            TextInput({ placeholder: '留空使用默认目录', text: this.saveDir })
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(13)
              .layoutWeight(1)
              .backgroundColor(this.p.surface)
              .borderRadius(8)
              .height(40)
              .onChange((v: string) => { this.saveDir = v; })
          }
          .width('100%')
          .margin({ bottom: 12 })

          // 线程数
          Text('线程数（留空=默认）').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          TextInput({ placeholder: '如 16', text: this.segmentsDraft })
            .fontColor(this.p.text)
            .placeholderColor(this.p.textSecondary)
            .fontSize(13)
            .width('100%')
            .backgroundColor(this.p.surface)
            .borderRadius(8)
            .height(40)
            .type(InputType.Number)
            .margin({ bottom: 12 })
            .onChange((v: string) => { this.segmentsDraft = v; })

          // Cookie
          Text('Cookie').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          TextInput({ placeholder: 'name=value; name2=value2', text: this.cookie })
            .fontColor(this.p.text)
            .placeholderColor(this.p.textSecondary)
            .fontSize(13)
            .width('100%')
            .backgroundColor(this.p.surface)
            .borderRadius(8)
            .height(40)
            .margin({ bottom: 12 })
            .onChange((v: string) => { this.cookie = v; })

          // Referer
          Text('Referer').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          TextInput({ placeholder: 'https://example.com', text: this.referer })
            .fontColor(this.p.text)
            .placeholderColor(this.p.textSecondary)
            .fontSize(13)
            .width('100%')
            .backgroundColor(this.p.surface)
            .borderRadius(8)
            .height(40)
            .margin({ bottom: 12 })
            .onChange((v: string) => { this.referer = v; })

          // 自定义请求头
          Text('自定义请求头（每行 Key: Value）').fontSize(13).fontColor(this.p.textSecondary).margin({ bottom: 6 })
          TextArea({ placeholder: 'X-Key: value\nAuthorization: Bearer xxx', text: this.customHeaders })
            .fontColor(this.p.text)
            .placeholderColor(this.p.textSecondary)
            .fontSize(13)
            .width('100%')
            .height(80)
            .backgroundColor(this.p.surface)
            .borderRadius(8)
            .onChange((v: string) => { this.customHeaders = v; })
        }
        .width('100%')
        .padding({ left: 4, right: 4, bottom: 4 })
      }

      // 支持协议标签
      Text('支持协议')
        .fontSize(13)
        .fontColor(this.p.textSecondary)
        .width('100%')
        .margin({ top: 20, bottom: 8 })

      Flex({ wrap: FlexWrap.Wrap, space: { main: LengthMetrics.vp(8), cross: LengthMetrics.vp(8) } }) {
        ForEach(ALL_PROTOCOLS, (proto: ProtocolType) => {
          this.ProtocolChip(
            protocolMeta(proto).label,
            protocolMeta(proto).color,
            protocolMeta(proto).implemented,
            protocolIcon(proto)
          )
        })
      }
      .width('100%')

      Button() {
        Row() {
          Image(iconRes('download')).width(18).height(18).fillColor(this.p.onPrimary)
          Text('开始下载').fontSize(16).fontColor(this.p.onPrimary).margin({ left: 6 })
        }
        .justifyContent(FlexAlign.Center)
      }
        .width('100%')
        .height(44)
        .backgroundColor(this.p.primary)
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
            promptAction.showToast({ message: '已添加下载任务' });
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
        TextArea({ text: this.batchUrls, placeholder: 'https://example.com/file1.zip\nhttps://example.com/file2.zip', controller: this.batchInputController })
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
            systemMaterialEffect: globalMaterialEffect(),
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
            systemMaterialEffect: globalMaterialEffect(),
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
                promptAction.showToast({ message: `已添加 ${n} 个下载` });
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
    .edgeEffect(EdgeEffect.Spring)
  }
}

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
  // 设置分组折叠状态（默认全部收起）
  @Local sectionDownload: boolean = false;
  @Local sectionAppearance: boolean = false;
  @Local sectionMcp: boolean = false;
  @Local sectionBt: boolean = false;
  @Local sectionRss: boolean = false;
  // 当前被按下的卡片式入口 key（统一物理按压反馈）
  @Local pressedKey: string = '';

  aboutToAppear(): void {
    this.fileExistsBehaviorLocal = this.vm.fileExistsBehavior;
    this.fileMissingActionLocal = this.vm.fileMissingAction;
    if (this.vm.btSettings) {
      this.btOperatorLocal = this.vm.btSettings.limits.operator === SeedConditionOperator.AND ? 'and' : 'or';
    }
  }

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
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
      // 有QQ，直接跳转QQ加群
      const want: Want = { uri: qqScheme };
      (getContext(this) as common.UIAbilityContext).startAbility(want).catch(() => {
        // QQ跳转失败，降级浏览器
        const h5Want: Want = { uri: h5Url };
        (getContext(this) as common.UIAbilityContext).startAbility(h5Want);
      });
    } else {
      // 没安装QQ，检测浏览器包名后直接指定浏览器打开（绕过系统选择逻辑，避免弹"暂无可打开方式"）
      const browserBundleNames = ['com.huawei.browser', 'com.huawei.browser.pad', 'com.android.chrome', 'com.microsoft.emmx'];
      let browserBundleName = '';
      for (const bn of browserBundleNames) {
        try {
          bundleManager.getBundleInfo(bn, bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
          browserBundleName = bn;
          break;
        } catch (_) {
          // 未安装，继续检测
        }
      }
      if (browserBundleName) {
        const h5Want: Want = { bundleName: browserBundleName, uri: h5Url };
        (getContext(this) as common.UIAbilityContext).startAbility(h5Want).catch(() => {
          // 指定浏览器打开失败，降级为系统方式
          const fallbackWant: Want = { uri: h5Url };
          (getContext(this) as common.UIAbilityContext).startAbility(fallbackWant);
        });
      } else {
        // 没检测到浏览器，复制链接
        pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, h5Url));
        promptAction.showToast({ message: '群链接已复制，请在浏览器中粘贴打开' });
      }
    }
  }

  /** 长按QQ群：复制群号 */
  private copyQQGroupNumber(): void {
    const groupNumber = '1121565536';
    pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, groupNumber));
    promptAction.showToast({ message: '群号已复制: ' + groupNumber });
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
      promptAction.showToast({ message: '请输入分类名称' });
      return;
    }
    this.vm.createCategory(name, this.catExts.trim(), this.catDir.trim()).then(() => {
      this.catName = '';
      this.catExts = '';
      this.catDir = '';
      promptAction.showToast({ message: '已添加分类' });
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
      promptAction.showToast({ message: '分类名称不能为空' });
      return;
    }
    this.vm.updateCategory(cat, { name: name, extensions: this.catEditExts.trim(), saveDir: this.catEditDir.trim() })
      .then(() => {
        this.catEditVisible = false;
        promptAction.showToast({ message: '已保存分类' });
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
            Image(iconRes('palette')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('外观').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text).layoutWeight(1)
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
                Image(iconRes(this.vm.theme === 'dark' ? 'moon' : 'sun')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image(iconRes('palette')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('配色').fontColor(this.p.text).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, top: 12, bottom: 4 })

          // ── 配色（18 色，按顺序排列，无文字） ──
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(COLOR_SCHEMES, (scheme: ColorScheme) => {
              Column() {
                Column()
                  .width(36)
                  .height(36)
                  .borderRadius(18)
                  .backgroundColor(this.p.dark && scheme.darkPrimary ? scheme.darkPrimary : scheme.primary)
                  .border({
                    width: this.vm.colorScheme === scheme.id ? 3 : 0,
                    color: this.p.text
                  })
              }
              .margin(8)
              .onClick(() => { this.vm.setColorScheme(scheme.id); })
            })
          }
          .padding({ left: 16, right: 16, top: 8, bottom: 16 })
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
            Image(iconRes('download')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image(iconRes('magnet')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('BT 下载').fontColor(this.p.text).layoutWeight(1).fontSize(15)
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
            Image(iconRes('chart')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image(iconRes('list')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image(iconRes('folder')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image(iconRes('download')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('下载设置').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })
          Column() {
              // ── 下载统计入口 ──
              Row() {
                Image(iconRes('chart')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
                Image(iconRes('cpu')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            .blockColor(this.p.primary)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('shield_check')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('校验完整性').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.verifyIntegrity, type: ToggleType.Switch })
              .onChange((v: boolean) => {
                this.vm.setVerify(v);
              })
          }
          .width('100%')
          .padding(16)

          // 全局限速
          Row() {
            Image(iconRes('gauge')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            .blockColor(this.p.primary)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // ── 下载策略（失败重试 / 文件策略 / 服务器时间） ──
          Row() {
            Image(iconRes('retry')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('失败自动重试').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Text(`${this.vm.autoRetryCount} 次`)
              .fontColor(this.p.primaryDark).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 6 })

          Row() {
            Text('重试次数 (0=关闭)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
            TextInput({ text: this.retryCountDraft, placeholder: String(this.vm.autoRetryCount) })
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
            TextInput({ text: this.retryDelayDraft, placeholder: String(this.vm.autoRetryDelaySec) })
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
            Image(iconRes('file_check')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('文件已存在时').fontColor(this.p.text).layoutWeight(1).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 8 })

          Row() {
            Text('覆盖')
              .fontSize(12)
              .fontColor(this.fileExistsBehaviorLocal === 'overwrite' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileExistsBehaviorLocal === 'overwrite' ? this.p.primary : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileExistsBehaviorLocal = 'overwrite'; this.vm.setFileExistsBehavior('overwrite'); })
            Text('重命名')
              .fontSize(12)
              .fontColor(this.fileExistsBehaviorLocal === 'rename' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileExistsBehaviorLocal === 'rename' ? this.p.primary : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileExistsBehaviorLocal = 'rename'; this.vm.setFileExistsBehavior('rename'); })
            Text('跳过')
              .fontSize(12)
              .fontColor(this.fileExistsBehaviorLocal === 'skip' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileExistsBehaviorLocal === 'skip' ? this.p.primary : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileExistsBehaviorLocal = 'skip'; this.vm.setFileExistsBehavior('skip'); })
          }
          .width('100%')
          .padding({ left: 12, right: 12, bottom: 10 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('file')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('重新检查时文件丢失').fontColor(this.p.text).layoutWeight(1).fontSize(15)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 14, bottom: 8 })

          Row() {
            Text('保留记录')
              .fontSize(12)
              .fontColor(this.fileMissingActionLocal === 'keep' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileMissingActionLocal === 'keep' ? this.p.primary : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileMissingActionLocal = 'keep'; this.vm.setFileMissingAction('keep'); })
            Text('移除任务')
              .fontSize(12)
              .fontColor(this.fileMissingActionLocal === 'remove' ? this.p.onPrimary : this.p.textSecondary)
              .backgroundColor(this.fileMissingActionLocal === 'remove' ? this.p.primary : this.p.surfaceHighlight)
              .borderRadius(14)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .margin({ right: 8 })
              .onClick(() => { this.fileMissingActionLocal = 'remove'; this.vm.setFileMissingAction('remove'); })
          }
          .width('100%')
          .padding({ left: 12, right: 12, bottom: 10 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('clock')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('使用服务器文件时间').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.useServerTime, type: ToggleType.Switch })
              .onChange((v: boolean) => {
                this.vm.setUseServerTime(v);
              })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('shield_check')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Column() {
              Text('忽略 TLS 证书错误').fontColor(this.p.text).fontSize(15)
              Text('自签名/过期证书的 HTTPS 源也可下载（有安全风险）').fontColor(this.p.textSecondary).fontSize(12)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Toggle({ isOn: this.vm.ignoreTlsErrors, type: ToggleType.Switch })
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
              Image(iconRes('globe')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
              Text('代理地址').fontColor(this.p.textSecondary).fontSize(13)
            }
            TextInput({ text: this.vm.proxyUrl, placeholder: 'http://host:port 或留空' })
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
              Image(iconRes('code')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
              TextInput({ text: this.vm.githubMirrorUrl, placeholder: '输入自定义镜像地址' })
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
            Image(iconRes('clipboard')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('剪贴板监听').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.clipboardMonitor, type: ToggleType.Switch })
              .onChange((v: boolean) => { this.vm.setClipboardMonitor(v); })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 完成通知
          Row() {
            Image(iconRes('bell')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('下载完成通知').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.notifyOnComplete, type: ToggleType.Switch })
              .onChange((v: boolean) => { this.vm.setNotifyOnComplete(v); })
          }
          .width('100%')
          .padding(16)

          // 实况窗胶囊
          Row() {
            Image(iconRes('eye')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('实况窗胶囊').fontColor(this.p.text).layoutWeight(1).fontSize(15)
            Toggle({ isOn: this.vm.liveViewEnabled, type: ToggleType.Switch })
              .onChange((v: boolean) => { this.vm.setLiveViewEnabled(v); })
          }
          .width('100%')
          .padding(16)

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 清理失效任务
          Row() {
            Column() {
              Row() {
                Image(iconRes('trash')).width(18).height(18).fillColor(this.p.error).margin({ right: 10 })
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
                  promptAction.showToast({ message: n > 0 ? `已清理 ${n} 个失效任务` : '没有失效任务' });
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
                .width(18)
                .height(18)
                .fillColor(this.p.primary)
                .margin({ right: 8 })
              Text('BT 下载')
                .fontSize(16)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.p.text)
                .layoutWeight(1)
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 16, bottom: 16 })

            Divider().color(this.p.border).margin({ left: 16, right: 16 })
            Column() {
            Row() {
              Text('启用 DHT').fontColor(this.p.text).layoutWeight(1).fontSize(15)
              Toggle({ type: ToggleType.Switch, isOn: this.vm.btSettings.enableDht })
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
              Toggle({ type: ToggleType.Switch, isOn: this.vm.btSettings.enableUpnp })
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
              TextInput({ text: this.btPortStartDraft, placeholder: String(this.vm.btSettings.listenPortStart) })
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btPortStartDraft = v; })
              Text('—').fontColor(this.p.textSecondary).fontSize(13).margin({ left: 4, right: 4 })
              TextInput({ text: this.btPortEndDraft, placeholder: String(this.vm.btSettings.listenPortEnd) })
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btPortEndDraft = v; })
            }
            .width('100%')

            Divider().color(this.p.border).margin({ top: 8, bottom: 8 })

            Row() {
              Text('完成后自动做种').fontColor(this.p.text).layoutWeight(1).fontSize(15)
              Toggle({ type: ToggleType.Switch, isOn: this.vm.btSettings.seedEnabled })
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
              Toggle({ type: ToggleType.Switch, isOn: this.vm.btSettings.autoReseed })
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
              TextInput({ text: this.btRatioDraft, placeholder: String(this.vm.btSettings.limits.ratioLimit) })
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btRatioDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 6 })

            Row() {
              Text('做种时长 (小时)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btTimeDraft, placeholder: String(Math.round(this.vm.btSettings.limits.timeLimitSec / 3600)) })
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btTimeDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 6 })

            Row() {
              Text('不活跃停止 (分钟)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btInactiveDraft, placeholder: String(Math.round(this.vm.btSettings.limits.inactiveTimeSec / 60)) })
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btInactiveDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 6 })

            Row() {
              Text('上传限速 (KB/s)').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btUploadDraft, placeholder: String(Math.round(this.vm.btSettings.limits.uploadLimit / 1024)) })
                .type(InputType.Number).fontSize(13).fontColor(this.p.text).width(90).height(36)
                .backgroundColor(Color.Transparent)
                .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                .onChange((v: string) => { this.btUploadDraft = v; })
            }
            .width('100%')
            .margin({ bottom: 6 })

            Row() {
              Text('同时做种数').fontSize(12).fontColor(this.p.textSecondary).layoutWeight(1)
              TextInput({ text: this.btMaxActiveDraft, placeholder: String(this.vm.btSettings.limits.maxActive) })
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
                .backgroundColor(this.btOperatorLocal === 'or' ? this.p.primary : this.p.surfaceHighlight)
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
                .backgroundColor(this.btOperatorLocal === 'and' ? this.p.primary : this.p.surfaceHighlight)
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
              .backgroundColor(this.p.primary)
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
                promptAction.showToast({ message: 'BT 设置已保存' });
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
            Image(iconRes('server')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('服务').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // MCP服务入口
          Row() {
            Image(iconRes('terminal')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image(iconRes('link')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image($r('app.media.ic_rss')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image(iconRes('server')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('MCP 服务').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })
          Column() {
              Row() {
                Column() {
                  Row() {
                    Image(iconRes('terminal')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
                    Text('MCP 本地服务').fontColor(this.p.text).fontSize(15)
                  }
                  Text('127.0.0.1:17800').fontColor(this.p.textSecondary).fontSize(12).margin({ top: 2 })
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                Toggle({ isOn: this.vm.mcpEnabled, type: ToggleType.Switch })
                  .onChange((v: boolean) => {
                    this.vm.setMcp(v);
                  })
              }
              .width('100%')
              .padding(16)

              Divider().color(this.p.border).margin({ left: 16, right: 16 })

              Column() {
                Row() {
                  Image(iconRes('lock')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
                  Text('Bearer Token').fontColor(this.p.textSecondary).fontSize(13)
                }
                TextInput({ text: this.vm.mcpToken })
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
            Image(iconRes('link')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('浏览器扩展').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          Row() {
            Image(iconRes('link')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
            Image(iconRes('list')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('下载队列').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text).layoutWeight(1)
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
                Image(iconRes('play')).width(14).height(14).fillColor(this.p.primary).margin({ right: 10 })
                Text('自动开始').fontSize(13).fontColor(this.p.textSecondary).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: q.autoStart })
                  .onChange((on: boolean) => {
                    q.autoStart = on;
                    this.vm.queueStoreUpdate(q);
                  })
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 2, bottom: 2 })

              Row() {
                Image(iconRes('timer')).width(14).height(14).fillColor(this.p.primary).margin({ right: 10 })
                Text('每日限时').fontSize(13).fontColor(this.p.textSecondary).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: q.scheduledEnabled })
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
                Image(iconRes('gauge')).width(14).height(14).fillColor(this.p.primary).margin({ right: 10 })
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
                .blockColor(this.p.primary)

              Row() {
                Button('开始')
                  .fontSize(12).backgroundColor('#52C41A').fontColor('#FFFFFF').height(30)
                  .margin({ right: 6 })
                  .onClick(() => { this.vm.startQueue(q.id); })
                Button('暂停')
                  .fontSize(12).backgroundColor('#FFA940').fontColor('#FFFFFF').height(30)
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
                  .fontSize(12).backgroundColor(this.p.error).fontColor('#FFFFFF').height(30)
                  .onClick(() => {
                    AlertDialog.show({
                      title: '删除队列',
                    message: `确定要删除队列「${q.name}」吗？任务不会受影响。`,
                    autoCancel: true,
                    alignment: DialogAlignment.Center,
                    primaryButton: { value: '取消', action: () => {} },
                    secondaryButton: {
                      value: '删除', fontColor: '#FF3B30',
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
                  TextInput({ text: this.queueSegDraft, placeholder: q.segments > 0 ? String(q.segments) : '默认' })
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
                TextInput({ text: this.queueUaDraft, placeholder: '留空 = 使用全局 UA' })
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
                TextInput({ text: this.queueDirDraft, placeholder: '留空 = 默认目录' })
                  .fontSize(13).fontColor(this.p.text).placeholderColor(this.p.textSecondary)
                  .backgroundColor(Color.Transparent)
                  .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                  .margin({ bottom: 10 })
                  .onChange((v: string) => { this.queueDirDraft = v; })

                Button('保存队列设置')
                  .fontSize(13).backgroundColor(this.p.primary).fontColor(this.p.onPrimary).width('100%').height(34)
                  .onClick(() => {
                    const seg = parseInt(this.queueSegDraft, 10);
                    if (!isNaN(seg) && seg >= 0 && seg <= 32) {
                      q.segments = seg;
                    }
                    q.ua = this.queueUaDraft.trim();
                    q.saveDir = this.queueDirDraft.trim();
                    this.vm.queueStoreUpdate(q);
                    this.queueAdvId = '';
                    promptAction.showToast({ message: '队列设置已保存' });
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
            TextInput({ text: this.newQueueName, placeholder: '新队列名称' })
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
              .backgroundColor(this.p.primary)
              .width('100%')
              .margin({ top: 8 })
              .onClick(() => {
                const name = this.newQueueName.trim();
                if (name.length === 0) {
                  promptAction.showToast({ message: '请输入队列名称' });
                  return;
                }
                this.vm.createQueue(name, 2).then(() => {
                  this.newQueueName = '';
                  promptAction.showToast({ message: '已创建队列' });
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
            Image(iconRes('folder')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
            Text('自定义分类').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text).layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })

          // 添加分类
          Column() {
            TextInput({ text: this.catName, placeholder: '分类名称（如 视频）' })
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(14)
              .onChange((v: string) => { this.catName = v; })
            TextInput({ text: this.catExts, placeholder: '扩展名规则，逗号分隔（如 mp4,mkv，留空=全部）' })
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(14)
              .margin({ top: 8 })
              .onChange((v: string) => { this.catExts = v; })
            TextInput({ text: this.catDir, placeholder: '保存目录（留空=默认）' })
              .fontColor(this.p.text)
              .placeholderColor(this.p.textSecondary)
              .fontSize(14)
              .margin({ top: 8 })
              .onChange((v: string) => { this.catDir = v; })
            Button('添加分类')
              .fontSize(14)
              .backgroundColor(this.p.primary)
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
                Image(iconRes('tag')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
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
                    AlertDialog.show({
                    title: '删除分类',
                    message: `确定要删除分类「${cat.name}」吗？任务不会受影响。`,
                    autoCancel: true,
                    alignment: DialogAlignment.Center,
                    primaryButton: { value: '取消', action: () => {} },
                    secondaryButton: {
                      value: '删除',
                      fontColor: '#FF3B30',
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
              .width(18)
              .height(18)
              .fillColor(this.p.primary)
              .margin({ right: 8 })
            Text('RSS 订阅')
              .fontSize(16)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.p.text)
              .layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 16, bottom: 16 })

          Divider().color(this.p.border).margin({ left: 16, right: 16 })
          Column() {
              TextInput({ text: this.rssUrl, placeholder: 'RSS 订阅地址' })
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .fontSize(14)
                .onChange((v: string) => { this.rssUrl = v; })
              TextInput({ text: this.rssName, placeholder: '名称' })
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .fontSize(14)
                .margin({ top: 8 })
                .onChange((v: string) => { this.rssName = v; })
              TextInput({ text: this.rssFilter, placeholder: '包含关键词 (逗号分隔, 任一命中)' })
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .fontSize(14)
                .margin({ top: 8 })
                .onChange((v: string) => { this.rssFilter = v; })
              TextInput({ text: this.rssExclude, placeholder: '排除关键词 (逗号分隔, 命中即跳过)' })
                .fontColor(this.p.text)
                .placeholderColor(this.p.textSecondary)
                .fontSize(14)
                .margin({ top: 8 })
                .onChange((v: string) => { this.rssExclude = v; })
              Button('添加订阅')
                .fontSize(14)
                .backgroundColor(this.p.primary)
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
                .backgroundColor(this.p.primary)
                .fontColor(this.p.onPrimary)
                .width('100%')
                .margin({ top: 8 })
                .onClick(() => {
                  this.vm.pollRss().then((n: number) => {
                    promptAction.showToast({ message: `新增 ${n} 个下载` });
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
                Toggle({ type: ToggleType.Switch, isOn: sub.enabled })
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
                  .backgroundColor(this.p.error)
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

        // ── 关于入口（仅在设置首页显示） ──
        if (this.mode === '') {
        Row() {
          Image(iconRes('info')).width(18).height(18).fillColor(this.p.primary).margin({ right: 10 })
          Text('关于').fontColor(this.p.text).layoutWeight(1).fontSize(16)
          Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
        }
        
        .padding(16)
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, top: 12 })
        .scale({ x: this.pressScale('about'), y: this.pressScale('about') })
        .animation({ duration: PRESS_DURATION, curve: Curve.Friction })
        .onTouch((event: TouchEvent) => {
          this.handlePress('about', event);
        })
        .onClick(() => {
          this.navStack.pushPath({ name: 'about' });
        })
        }

      }
      .width('100%')
      .padding({ bottom: 88 })
      .justifyContent(FlexAlign.Start)
      .alignItems(HorizontalAlign.Start)
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .edgeEffect(EdgeEffect.None)
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
        TextInput({ text: this.rssEditInterval, placeholder: '30' })
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
        Toggle({ type: ToggleType.Switch, isOn: this.rssEditAuto })
          .onChange((on: boolean) => { this.rssEditAuto = on; })
      }
      .width('100%')
      .margin({ bottom: 10 })

      Text('排除关键词 (逗号分隔)').fontSize(13).fontColor(this.p.text).margin({ bottom: 6 })
      TextInput({ text: this.rssEditExclude, placeholder: '命中即跳过' })
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
          TextInput({ text: this.rssEditSizeMin, placeholder: '0 = 不限' })
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
          TextInput({ text: this.rssEditSizeMax, placeholder: '0 = 不限' })
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
          .backgroundColor(this.p.primary)
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
      .backgroundColor(this.rssEditQueueId === id ? this.p.primary : this.p.surfaceHighlight)
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
      .backgroundColor(this.vm.themeMode === mode ? this.p.primary : this.p.surfaceHighlight)
      .borderRadius(14)
      .padding({ left: 12, right: 12, top: 5, bottom: 5 })
      .margin({ right: 8 })
      .onClick(() => {
        this.vm.setThemeMode(mode);
        if (mode !== 'system') {
          this.vm.setTheme(mode);
        }
      })
  }

  @Builder
  PolicyChip(label: string, value: string, current: string, onPick: (v: string) => void) {
    Text(label)
      .fontSize(12)
      .fontColor(current === value ? this.p.onPrimary : this.p.textSecondary)
      .backgroundColor(current === value ? this.p.primary : this.p.surfaceHighlight)
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
        TextInput({ text: this.catEditName, placeholder: '分类名称' })
          .fontSize(14).fontColor(this.p.text).placeholderColor(this.p.textSecondary)
          .backgroundColor(this.p.surfaceHighlight).borderRadius(8).width('100%').margin({ top: 16 })
          .onChange((v: string) => { this.catEditName = v; })
        TextInput({ text: this.catEditExts, placeholder: '扩展名，逗号分隔（留空=全部）' })
          .fontSize(14).fontColor(this.p.text).placeholderColor(this.p.textSecondary)
          .backgroundColor(this.p.surfaceHighlight).borderRadius(8).width('100%').margin({ top: 8 })
          .onChange((v: string) => { this.catEditExts = v; })
        TextInput({ text: this.catEditDir, placeholder: '保存目录（留空=默认）' })
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
            .backgroundColor(this.p.primary).fontColor(this.p.onPrimary)
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

// ── 关于页面 ──
@ComponentV2
struct AboutContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();
  @Param onCheckUpdate?: () => void = undefined;

  // 双击版本号复制日志（双击判定窗口 350ms）
  @Local lastVersionClick: number = 0;
  @Local qqGroupSheetVisible: boolean = false;

  private copyQQGroupNumber(): void {
    const groupNumber = '1121565536';
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, groupNumber);
    pasteboard.getSystemPasteboard().setData(data);
    promptAction.showToast({ message: '群号已复制' });
  }

  private onVersionClick(): void {
    const now = Date.now();
    if (now - this.lastVersionClick < 350) {
      const logs = logCollector.getAll();
      const pasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, logs);
      pasteboard.getSystemPasteboard().setData(pasteData);
      promptAction.showToast({ message: `日志已复制（${logCollector.getCount()}条）` });
      this.lastVersionClick = 0;
    } else {
      this.lastVersionClick = now;
    }
  }

  /** 打开QQ群：检测QQ，有QQ直接跳转，没QQ用浏览器打开 */
  private openQQGroup(): void {
    const groupNumber = '1121565536';
    const h5Url = 'https://qun.qq.com/universal-share/share?ac=1&authKey=Jcxm9Kgi22K0O%2FPwws6chnIVQSjKNpEAcfq0tADTNJ1EwMFzohA4YOlXuwOz%2B8xz&busi_data=eyJncm91cENvZGUiOiIxMTIxNTY1NTM2IiwidG9rZW4iOiJwSzBkNTFKSGFGbXRjZk5pOFE0aGtQSDZSMHN0MnExWVJGcDR6WlgzeE5VcEJ0M3JTcnIrZHNlc0kzK3RRV1lJIiwidWluIjoiMTAxMjQ0MzU1NyJ9&data=Hvy3TedB6d7PgopsRuZzjY00d9OYpE_-5ASDCIym0LPHvCNBY6s7Q6IAdChl4iYB5L1L6r7YVZ4fQz0Dio5PGQ&svctype=4&tempid=h5_group_info';
    const qqScheme = `mqqapi://card/show_pslcard?src_type=internal&version=1&uin=${groupNumber}&card_type=group&source=qrcode`;
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
      const want: Want = { uri: qqScheme };
      (getContext(this) as common.UIAbilityContext).startAbility(want).catch(() => {
        const h5Want: Want = { uri: h5Url };
        (getContext(this) as common.UIAbilityContext).startAbility(h5Want);
      });
    } else {
      const browserBundleNames = ['com.huawei.browser', 'com.huawei.browser.pad', 'com.android.chrome', 'com.microsoft.emmx'];
      let browserBundleName = '';
      for (const bn of browserBundleNames) {
        try {
          bundleManager.getBundleInfo(bn, bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
          browserBundleName = bn;
          break;
        } catch (_) { }
      }
      if (browserBundleName) {
        const want: Want = { uri: h5Url, bundleName: browserBundleName };
        (getContext(this) as common.UIAbilityContext).startAbility(want);
      } else {
        const want: Want = { uri: h5Url };
        (getContext(this) as common.UIAbilityContext).startAbility(want);
      }
    }
  }

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  build() {
    Scroll() {
      Column() {
        // App icon & name
        Column() {
          Image($r('app.media.app_icon'))
            .width(80)
            .height(80)
            .borderRadius(20)
            .margin({ bottom: 12 })

          Text('FluxDown Cover')
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.p.text)

          Text(`v${APP_VERSION}`)
            .fontSize(14)
            .fontColor(this.p.textSecondary)
            .margin({ top: 4 })
            .onClick(() => { this.onVersionClick(); })
        }
        .width('100%')
        .padding({ top: 36, bottom: 28 })
        .alignItems(HorizontalAlign.Center)
          .transition(TransitionEffect.translate({ x: 40 }).combine(TransitionEffect.OPACITY).animation({ duration: 250, curve: Curve.EaseOut }))

        // 关于本应用（简介 + 支持协议融合）
        Column() {
          Text('关于本应用')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.p.textSecondary)
            .width('100%')
            .margin({ bottom: 10 })

          Scroll() {
            Column() {
              Text('FluxDown Cover 是一款多协议下载管理器，支持 HTTP/HTTPS、FTP、HLS/DASH 流媒体、BitTorrent P2P、eD2K 网络及迅雷/快车/旋风专用链接。基于 HarmonyOS NEXT 原生开发，提供流畅的下载体验与任务管理功能。')
                .fontSize(14)
                .fontColor(this.p.text)
                .lineHeight(22)
                .width('100%')
                .margin({ bottom: 16 })

              Text('支持协议')
                .fontSize(13)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.p.textSecondary)
                .width('100%')
                .margin({ bottom: 10 })

              ForEach(ALL_PROTOCOLS, (pt: ProtocolType) => {
                this.ProtocolItem(protocolMeta(pt))
              }, (pt: ProtocolType) => pt)
            }
            .width('100%')
          }
          .scrollBar(BarState.Off)
          .height(220)
          .width('100%')
        }
        .padding(16)
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, bottom: 16 })

        // ── 作者 ──
        Column() {
          Row() {
            Image('https://avatars.githubusercontent.com/zerx-lab?v=4')
              .width(40)
              .height(40)
              .borderRadius(20)
            Column() {
              Text('原开发').fontSize(12).fontColor(this.p.textSecondary)
              Text('zerx-lab').fontSize(14).fontColor(this.p.text).fontWeight(FontWeight.Medium)
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
            .margin({ left: 12 })
          }
          .width('100%')
          .onClick(() => {
            const want: Want = { uri: 'https://github.com/zerx-lab' };
            (getContext(this) as common.UIAbilityContext).startAbility(want);
          })

          Divider().color(this.p.border).strokeWidth(1).margin({ top: 12, bottom: 12 })

          Row() {
            Image('https://avatars.githubusercontent.com/Pkeji?v=4')
              .width(40)
              .height(40)
              .borderRadius(20)
            Column() {
              Text('移植开发').fontSize(12).fontColor(this.p.textSecondary)
              Text('Pkeji').fontSize(14).fontColor(this.p.text).fontWeight(FontWeight.Medium)
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
            .margin({ left: 12 })
          }
          .width('100%')
          .onClick(() => {
            const want: Want = { uri: 'https://github.com/Pkeji' };
            (getContext(this) as common.UIAbilityContext).startAbility(want);
          })
        }
        .padding(16)
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, bottom: 16 })

        // QQ群
        Row() {
          Image(iconRes('qq'))
            .width(18).height(18).objectFit(ImageFit.Contain).margin({ right: 10 })
          Text('QQ 交流群').fontColor(this.p.text).layoutWeight(1).fontSize(16)
          Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary).margin({ left: 8 })
        }
        .padding(16)
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, bottom: 16 })
        .onClick(() => { this.qqGroupSheetVisible = true; })

        // 检查更新
        Row() {
          Text('检查更新').fontColor(this.p.text).layoutWeight(1).fontSize(16)
          if (this.onCheckUpdate) {
            Text('→').fontColor(this.p.textSecondary).fontSize(16)
          }
        }
        .padding(16)
        .backgroundColor(this.p.surface)
        .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
        .borderRadius(RADIUS_CARD)
        .margin({ left: 16, right: 16, bottom: 16 })
        .onClick(() => {
          this.onCheckUpdate?.();
        })

        Text('© 2026 FluxDown Cover for HarmonyOS')
          .fontSize(12)
          .fontColor(this.p.textSecondary)
          .margin({ bottom: 32 })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Center)
          .transition(TransitionEffect.translate({ x: 40 }).combine(TransitionEffect.OPACITY).animation({ duration: 250, curve: Curve.EaseOut }))
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .edgeEffect(EdgeEffect.Spring)
    .bindSheet($$this.qqGroupSheetVisible, this.QQGroupSheet(), {
      height: 260,
      dragBar: true,
      showClose: false,
      backgroundColor: this.p.surface,
      blurStyle: BlurStyle.COMPONENT_THIN
    })
  }

  @Builder
  ProtocolItem(meta: ProtocolMeta) {
    Row() {
      Image(iconRes(protocolLabelIcon(meta.label)))
        .width(15).height(15).fillColor(meta.color)
        .margin({ right: 10 })

      Column() {
        Row() {
          Text(meta.label).fontSize(13).fontColor(this.p.text).fontWeight(FontWeight.Medium)
          if (!meta.implemented) {
            Text('开发中')
              .fontSize(10)
              .fontColor(this.p.textSecondary)
              .backgroundColor(this.p.surfaceHighlight)
              .borderRadius(4)
              .padding({ left: 6, right: 6, top: 2, bottom: 2 })
              .margin({ left: 8 })
          }
        }
        Text(meta.fullDesc).fontSize(12).fontColor(this.p.textSecondary).margin({ top: 2 })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .margin({ bottom: 10 })
  }

  @Builder
  QQGroupSheet() {
    Column({ space: 16 }) {
      Row() {
        Text('加入QQ交流群')
          .fontSize(18)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.p.text)
          .layoutWeight(1)
        Stack({ alignContent: Alignment.Center }) {
          Column()
            .width(32).height(32)
            .borderRadius(16)
            .backgroundColor(this.p.dark ? '#F23A3A3A' : '#F2F3F5')
            .border({ width: 0.5, color: this.p.dark ? '#33FFFFFF' : '#1A000000' })
          Image(iconRes('x'))
            .width(16).height(16)
            .fillColor(this.p.text)
        }
        .onClick(() => { this.qqGroupSheetVisible = false; })
      }
      .width('100%')

      Text('群号：1121565536')
        .fontSize(14)
        .fontColor(this.p.textSecondary)

      Row({ space: 12 }) {
        Stack({ alignContent: Alignment.Center }) {
          ImmersionButton({
            systemMaterialEffect: globalMaterialEffect(),
            text: '复制群号',
            buttonModify: new ActionButtonModifier('100%', 44),
            click: (): void => {
              this.copyQQGroupNumber();
            }
          })
          .width('100%')
          .height(44)
        }
        .layoutWeight(1)
        .height(44)
        Stack({ alignContent: Alignment.Center }) {
          ImmersionButton({
            systemMaterialEffect: globalMaterialEffect(),
            text: '加入QQ群',
            buttonModify: new ActionButtonModifier('100%', 44),
            click: (): void => {
              this.qqGroupSheetVisible = false;
              this.openQQGroup();
            }
          })
          .width('100%')
          .height(44)
        }
        .layoutWeight(1)
        .height(44)
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 24, right: 24, top: 20, bottom: 24 })
    .alignItems(HorizontalAlign.Center)
  }
}

// ── 任务详情页面 ──
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
          // ── 基础信息 ──
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
                  .backgroundColor(this.p.primary)
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
                  .backgroundColor('#FFA940').borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                  .onClick(() => { this.vm.pause(this.task); })
              } else if (this.task.status === TaskStatus.Paused || this.task.status === TaskStatus.Error) {
                Button() {
                  Row() {
                    Image(iconRes('play')).width(14).height(14).fillColor('#FFFFFF')
                    Text('继续下载').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                  .backgroundColor('#52C41A').borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                  .onClick(() => { this.vm.resume(this.task); })
              }
              if (this.task.status === TaskStatus.Completed) {
                Button() {
                  Row() {
                    Image(iconRes('open')).width(14).height(14).fillColor('#FFFFFF')
                    Text('打开文件').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                  .backgroundColor('#007DFF').borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                  .onClick(() => { this.openFromDetail(); })
              }
            }
            .width('100%')

            if (this.task.status !== TaskStatus.Downloading && this.task.status !== TaskStatus.Verifying) {
              Row() {
                Button() {
                  Row() {
                    Image(iconRes('rename')).width(14).height(14).fillColor(this.p.text)
                    Text('重命名').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                  .backgroundColor(this.p.surfaceSolid).borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                  .onClick(() => {
                    this.renameDraft = this.task.fileName;
                    this.renameVisible = true;
                  })
                Button() {
                  Row() {
                    Image(iconRes('folder')).width(14).height(14).fillColor(this.p.text)
                    Text('移动').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                  .backgroundColor(this.p.surfaceSolid).borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                  .onClick(() => {
                    this.movePathDraft = this.task.dirPath || this.task.filePath || '';
                    this.moveVisible = true;
                  })
                Button() {
                  Row() {
                    Image(iconRes('recheck')).width(14).height(14).fillColor(this.p.text)
                    Text('重新检查').fontSize(13).fontColor(this.p.text).margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                  .backgroundColor(this.p.surfaceSolid).borderRadius(8).height(36).layoutWeight(1).margin({ right: 6 })
                  .onClick(() => {
                    this.vm.recheckTask(this.task).then(() => {
                      promptAction.showToast({ message: '重新检查完成' });
                    }).catch((e: Error) => {
                      promptAction.showToast({ message: e?.message || '重新检查失败' });
                    });
                  })
                Button() {
                  Row() {
                    Image(iconRes('trash')).width(14).height(14).fillColor('#FFFFFF')
                    Text('删除').fontSize(13).fontColor('#FFFFFF').margin({ left: 4 })
                  }
                  .justifyContent(FlexAlign.Center)
                }
                  .backgroundColor('#E8553B').borderRadius(8).height(36).layoutWeight(1)
                  .onClick(() => {
                    AlertDialog.show({
                      title: '删除任务',
                      message: '确定要删除此下载任务吗？\n相关文件将被同时删除。',
                      autoCancel: true,
                      alignment: DialogAlignment.Center,
                      primaryButton: { value: '取消', action: () => {} },
                      secondaryButton: {
                        value: '删除',
                        fontColor: '#FF3B30',
                        action: () => { this.vm.remove(this.task); }
                      }
                    });
                  })
              }
              .width('100%')
              .margin({ top: 8 })
            }
          }
          .padding(12)
          .backgroundColor(this.p.surface)
                    .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
                    .borderRadius(RADIUS_CARD)
          .margin({ left: 12, right: 12, bottom: 12 })
        }
        .width('100%')
        .padding({ bottom: 60 })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
      .width('100%')

      // ── 重命名对话框覆盖层 ──
      if (this.renameVisible) {
        this.RenameOverlay()
      }
      if (this.moveVisible) {
        this.MoveOverlay()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
  }

  @Builder
  RenameOverlay() {
    Column() {
      Blank()
      Column() {
        Text('重命名').fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        TextInput({ text: this.renameDraft, placeholder: '输入新文件名' })
          .fontSize(14)
          .fontColor(this.p.text)
          .placeholderColor(this.p.textSecondary)
          .backgroundColor(this.p.surfaceHighlight)
          .borderRadius(8)
          .width('100%')
          .margin({ top: 16 })
          .onChange((v: string) => { this.renameDraft = v; })
        Row() {
          Button('取消')
            .type(ButtonType.Capsule)
            .fontSize(14)
            .backgroundColor(this.p.surfaceSolid)
            .fontColor(this.p.textSecondary)
            .layoutWeight(1)
            .margin({ right: 8 })
            .onClick(() => { this.renameVisible = false; })
          Button('确定')
            .type(ButtonType.Capsule)
            .fontSize(14)
            .backgroundColor(this.p.primary)
            .fontColor(this.p.onPrimary)
            .layoutWeight(1)
            .margin({ left: 8 })
            .onClick(() => {
              const name = this.renameDraft.trim();
              if (name.length === 0) {
                this.renameVisible = false;
                return;
              }
              this.vm.renameTask(this.task, name).then(() => {
                promptAction.showToast({ message: '已重命名' });
                this.renameVisible = false;
              }).catch((e: Error) => {
                promptAction.showToast({ message: '重命名失败: ' + (e?.message || String(e)) });
              });
            })
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

  @Builder
  MoveOverlay() {
    Column() {
      Blank()
      Column() {
        Text('移动到').fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        TextInput({ text: this.movePathDraft, placeholder: '输入目标文件夹路径' })
          .fontSize(14)
          .fontColor(this.p.text)
          .placeholderColor(this.p.textSecondary)
          .backgroundColor(this.p.surfaceHighlight)
          .borderRadius(8)
          .width('100%')
          .margin({ top: 16 })
          .onChange((v: string) => { this.movePathDraft = v; })
        Row() {
          Button('取消')
            .type(ButtonType.Capsule)
            .fontSize(14)
            .backgroundColor(this.p.surfaceSolid)
            .fontColor(this.p.textSecondary)
            .layoutWeight(1)
            .margin({ right: 8 })
            .onClick(() => { this.moveVisible = false; })
          Button('确定')
            .type(ButtonType.Capsule)
            .fontSize(14)
            .backgroundColor(this.p.primary)
            .fontColor(this.p.onPrimary)
            .layoutWeight(1)
            .margin({ left: 8 })
            .onClick(() => {
              const dir = this.movePathDraft.trim();
              if (dir.length === 0) {
                this.moveVisible = false;
                return;
              }
              this.vm.moveTask(this.task, dir).then(() => {
                promptAction.showToast({ message: '已移动' });
                this.moveVisible = false;
              }).catch((e: Error) => {
                promptAction.showToast({ message: '移动失败: ' + (e?.message || String(e)) });
              });
            })
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

  private doneSegments(): number {
    return this.task.segments.filter(s => s.done).length;
  }

  private queueNameOf(queueId: string): string {
    const q = this.vm.listQueues().find((x: DownloadQueue) => x.id === queueId);
    return q ? q.name : '未知队列';
  }

  private seedStatusText(s: string): string {    switch (s) {
      case 'seeding':
        return '做种中';
      case 'queued':
        return '排队做种';
      case 'userStopped':
        return '已停止（用户）';
      case 'limitReached':
        return '已停止（达到限制）';
      default:
        return '未做种';
    }
  }

  private openFromDetail(): void {
    // Reuse the master page's openFile via a lightweight capability: export + view.
    this.vm.exportToDownload(this.task).then((path: string) => {
      const ctx = getContext(this) as common.UIAbilityContext;
      const fileUriObj = fileUri.getUriFromPath(path);
      const want: Want = {
        action: 'ohos.want.action.viewData',
        uri: fileUriObj,
        flags: wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION | wantConstant.Flags.FLAG_AUTH_WRITE_URI_PERMISSION,
      };
      ctx.startAbility(want);
    }).catch((e: Error) => {
      promptAction.showToast({ message: '打开文件失败: ' + ((e as Error)?.message || String(e)) });
    });
  }

  @Builder
  Row2(k: string, v: string) {
    Row() {
      Text(k).fontSize(13).fontColor(this.p.textSecondary).width('30%')
      Text(v)
        .fontSize(13)
        .fontColor(this.p.text)
        .layoutWeight(1)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .copyOption(CopyOptions.LocalDevice)
    }
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .width('100%')
  }
}

// ── 下载队列页面 ──
// ── 下载统计页面 ──
@ComponentV2
struct StatsContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
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
    .edgeEffect(EdgeEffect.Spring)
  }

  @Builder
  StatRow(label: string, value: string, icon: string) {
    Row() {
      Image(iconRes(icon)).width(16).height(16).fillColor(this.p.primary).margin({ right: 12 })
      Text(label).fontSize(14).fontColor(this.p.textSecondary).layoutWeight(1)
      Text(value).fontSize(14).fontColor(this.p.text)
    }
    .width('100%')
    .padding({ top: 10, bottom: 10 })
  }
}
