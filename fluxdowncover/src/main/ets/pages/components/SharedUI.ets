/**
 * Shared UI types, constants, and utility functions used across components.
 * Extracted from the original monolithic Index.ets to reduce file size and
 * enable tree-shaking / faster incremental compilation.
 */

import { hdsMaterial, SystemMaterialParams } from '@kit.UIDesignKit';
import { ButtonModifier, UIContext } from '@kit.ArkUI';
import { getScheme } from '../../utils/ColorSchemes';
import { TaskStatus } from '../../model/TaskStatus';
import { ProtocolType } from '../../model/ProtocolType';
import { protocolMeta, ProtocolMeta } from '../../utils/common';

// ── 缩放/动画常量 ──
export const PRESS_SCALE: number = 0.97;
export const PRESS_SCALE_STRONG: number = 0.92;
export const PRESS_DURATION: number = 160;
// 统一圆角层级：卡片 14、弹层/子页面 18
export const RADIUS_CARD: number = 14;
export const RADIUS_SHEET: number = 18;
// 弹层进场/退场时长
export const SHEET_OPEN_DURATION: number = 300;
export const SHEET_CLOSE_DURATION: number = 200;
// P1 材质：毛玻璃模糊档位与 0.5px 描边
export const MATERIAL_BLUR: BlurStyle = BlurStyle.COMPONENT_THIN;
export const MATERIAL_BORDER_WIDTH: number = 0.5;

/** 毛玻璃描边色 */
export function materialBorder(dark: boolean): string {
  return dark ? '#26FFFFFF' : '#14000000';
}

// ── 颜色工具 ──
function parseHexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

function srgbChannel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminanceHex(hex: string): number {
  const rgb = parseHexRgb(hex);
  return 0.2126 * srgbChannel(rgb[0]) + 0.7152 * srgbChannel(rgb[1]) + 0.0722 * srgbChannel(rgb[2]);
}

function contrastRatioHex(fg: string, bg: string): number {
  const lf = relativeLuminanceHex(fg);
  const lb = relativeLuminanceHex(bg);
  const hi = Math.max(lf, lb);
  const lo = Math.min(lf, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHex2(r: number, g: number, b: number): string {
  const h = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (mx === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (mx === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  ];
}

function darkenHex(hex: string, amount: number = 0.08): string {
  const rgb0 = parseHexRgb(hex);
  const hsl0 = rgbToHsl(rgb0[0], rgb0[1], rgb0[2]);
  const nrgb = hslToRgb(hsl0[0], hsl0[1], Math.max(0, hsl0[2] - amount));
  return rgbToHex2(nrgb[0], nrgb[1], nrgb[2]);
}

function ensureContrast(fg: string, bg: string, target: number): string {
  let best = fg;
  const rgb = parseHexRgb(fg);
  const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const isDark = relativeLuminanceHex(bg) < 0.2;
  let candidate = fg;
  for (let i = 0; i < 15; i++) {
    if (contrastRatioHex(candidate, bg) >= target) {
      best = candidate;
      break;
    }
    const step = 0.04;
    const nl = isDark ? Math.min(1, hsl[2] + step) : Math.max(0, hsl[2] - step);
    const nrgb = hslToRgb(hsl[0], hsl[1], nl);
    candidate = rgbToHex2(nrgb[0], nrgb[1], nrgb[2]);
  }
  return best;
}

function ensureBgForOnWhite(hex: string): string {
  return ensureContrast(hex, '#F2F3F5', 4.5);
}

export function withAlpha(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const aHex = Math.round(a * 255).toString(16).padStart(2, '0');
  return hex + aHex.toUpperCase();
}

export function softShadow(dark: boolean, elevated: boolean = false): ShadowOptions {
  return {
    radius: elevated ? 24 : 20,
    color: dark ? (elevated ? '#40000000' : '#33000000') : (elevated ? '#1A000000' : '#14000000'),
    offsetX: 0,
    offsetY: elevated ? 10 : 8
  };
}

// ── 调色板类型 ──
export interface Palette {
  dark: boolean;
  bg: string;
  surface: string;
  surfaceSolid: string;
  surfaceHighlight: string;
  materialBg: string;
  text: string;
  textSecondary: string;
  primary: string;
  primarySolid: string;
  primaryDark: string;
  onPrimary: string;
  primaryFill: string;
  primaryTint: string;
  border: string;
  success: string;
  warning: string;
  error: string;
  successSolid: string;
  warningSolid: string;
  errorSolid: string;
}

export interface HlsVariantResult {
  urls: string[];
  labels: string[];
}

// ── 调色板生成 ──
export function palette(theme: 'light' | 'dark', colorSchemeId: string = 'cyan'): Palette {
  const scheme = getScheme(colorSchemeId);
  const dark = theme === 'dark';
  if (dark) {
    return {
      dark: true,
      bg: '#0D0D0D',
      surface: '#161618',
      surfaceSolid: '#1C1C1E',
      surfaceHighlight: '#242428',
      materialBg: withAlpha(scheme.primary, 0.08),
      text: '#F2F3F5',
      textSecondary: '#9A9CA0',
      primary: scheme.primary,
      primarySolid: ensureBgForOnWhite(scheme.primary),
      primaryDark: darkenHex(scheme.primary, 0.15),
      onPrimary: '#FFFFFF',
      primaryFill: withAlpha(scheme.primary, 0.12),
      primaryTint: withAlpha(scheme.primary, 0.25),
      border: '#2E2E32',
      success: scheme.success,
      warning: scheme.warning,
      error: scheme.error,
      successSolid: ensureBgForOnWhite(ensureContrast(scheme.success, '#F2F3F5', 4.5)),
      warningSolid: ensureBgForOnWhite(ensureContrast(scheme.warning, '#F2F3F5', 4.5)),
      errorSolid: ensureBgForOnWhite(ensureContrast(scheme.error, '#F2F3F5', 4.5))
    };
  }
  return {
    dark: false,
    bg: '#F2F3F5',
    surface: '#FFFFFF',
    surfaceSolid: '#FFFFFF',
    surfaceHighlight: '#F7F7F9',
    materialBg: withAlpha(scheme.primary, 0.06),
    text: '#1F1F23',
    textSecondary: '#6B7280',
    primary: scheme.primary,
    primarySolid: ensureBgForOnWhite(scheme.primary),
    primaryDark: darkenHex(scheme.primary, 0.12),
    onPrimary: ensureContrast(scheme.primary, '#FFFFFF', 4.5) === scheme.primary ? '#FFFFFF' : '#1F1F23',
    primaryFill: withAlpha(scheme.primary, 0.10),
    primaryTint: withAlpha(scheme.primary, 0.20),
    border: '#E5E7EB',
    success: ensureContrast(scheme.success, '#F2F3F5', 4.5),
    warning: ensureContrast(scheme.warning, '#F2F3F5', 4.5),
    error: ensureContrast(scheme.error, '#F2F3F5', 4.5),
    successSolid: ensureBgForOnWhite(ensureContrast(scheme.success, '#F2F3F5', 4.5)),
    warningSolid: ensureBgForOnWhite(ensureContrast(scheme.warning, '#F2F3F5', 4.5)),
    errorSolid: ensureBgForOnWhite(ensureContrast(scheme.error, '#F2F3F5', 4.5))
  };
}

// ── 状态文本 ──
export function statusText(s: TaskStatus): string {
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

// ── 协议工具 ──
export function protocolIcon(proto: ProtocolType): string {
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

export function protocolColor(p: ProtocolType, palette: Palette): string {
  return p === ProtocolType.BITTORRENT ? palette.error
    : p === ProtocolType.ED2K ? palette.warning
      : p === ProtocolType.HLS ? palette.primary
        : p === ProtocolType.FTP ? palette.textSecondary
          : p === ProtocolType.THUNDER ? palette.warning
            : palette.primary;
}

export function protocolLabel(p: ProtocolType): string {
  const m = protocolMeta(p);
  return m ? m.label : '未知';
}

export function protocolLabelIcon(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('torrent') || l.includes('磁力')) return 'magnet';
  if (l.includes('ed2k') || l.includes('电驴')) return 'hash';
  if (l.includes('hls') || l.includes('dash')) return 'video';
  if (l.includes('ftp') || l.includes('sftp')) return 'server';
  if (l.includes('thunder') || l.includes('迅雷')) return 'zap';
  if (l.includes('https')) return 'lock';
  if (l.includes('http')) return 'globe';
  return 'link';
}

// ── 状态图标 ──
export function statusIcon(s: TaskStatus): string {
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
      return 'loader';
    case TaskStatus.Completed:
      return 'check';
    case TaskStatus.Error:
      return 'alert';
    default:
      return 'help';
  }
}

// ── 任务过滤 ──
export function filterTaskLabel(label: string): string {
  switch (label) {
    case 'BITTORRENT':
      return 'BitTorrent';
    case 'ED2K':
      return 'eD2k';
    case 'THUNDER':
      return '迅雷';
    case 'HLS':
      return 'HLS';
    case 'DASH':
      return 'DASH';
    case 'FTP':
    case 'SFTP':
      return 'FTP';
    case 'HTTPS':
      return 'HTTPS';
    case 'HTTP':
      return 'HTTP';
    default:
      return label;
  }
}

// ── 材质效果 ──
/** 按外观设置映射系统材质：风格 auto/glassy/flat，浓度 auto/high/medium/low */
export function buildMaterialEffect(style: string, level: string): SystemMaterialParams {
  let mt: hdsMaterial.MaterialType;
  if (style === 'glassy') {
    mt = hdsMaterial.MaterialType.IMMERSIVE;
  } else if (style === 'flat') {
    mt = hdsMaterial.MaterialType.NONE;
  } else {
    mt = hdsMaterial.MaterialType.ADAPTIVE;
  }
  let ml: hdsMaterial.MaterialLevel;
  if (level === 'high') {
    ml = hdsMaterial.MaterialLevel.EXQUISITE;
  } else if (level === 'medium') {
    ml = hdsMaterial.MaterialLevel.GENTLE;
  } else if (level === 'low') {
    ml = hdsMaterial.MaterialLevel.SMOOTH;
  } else {
    ml = hdsMaterial.MaterialLevel.ADAPTIVE;
  }
  return { materialType: mt, materialLevel: ml };
}

// ── 图标映射表 ──
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
  ['grid_dots', $r('app.media.ic_grid_dots')],
  ['github', $r('app.media.ic_github')],
  ['qq', $r('app.media.ic_qq')],
  ['update', $r('app.media.ic_update')],
  ['donate', $r('app.media.ic_donate')],
  ['more_v', $r('app.media.ic_more_horizontal')],
  ['search', $r('app.media.ic_search')],
  ['eye', $r('app.media.ic_eye')],
  ['eye_off', $r('app.media.ic_eye_off')],
  ['bell', $r('app.media.ic_bell')],
  ['bell_off', $r('app.media.ic_bell')],
  ['link', $r('app.media.ic_link')],
  ['zap', $r('app.media.ic_zap')],
  ['globe', $r('app.media.ic_globe')],
  ['server', $r('app.media.ic_server')],
  ['lock', $r('app.media.ic_lock')],
  ['magnet', $r('app.media.ic_magnet')],
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
  ['refresh', $r('app.media.ic_refresh_cw')],
  ['arrow_left', $r('app.media.ic_arrow_left')],
  ['arrow_right', $r('app.media.ic_arrow_right')],
  ['chevron_left', $r('app.media.ic_chevron_left')],
  ['chevron_right', $r('app.media.ic_chevron_right')],
  ['maximize', $r('app.media.ic_chevron_up')],
  ['minimize', $r('app.media.ic_chevron_down')],
  ['info', $r('app.media.ic_info')],
  ['help', $r('app.media.ic_badge_info')],
  ['external', $r('app.media.ic_external_link')],
  ['sort_asc', $r('app.media.ic_arrow_up_a_z')],
  ['sort_desc', $r('app.media.ic_arrow_down_z_a')],
  ['filter', $r('app.media.ic_filter')],
  ['tag', $r('app.media.ic_tag')],
  ['ban', $r('app.media.ic_shield_ban')],
  ['wifi', $r('app.media.ic_wifi')],
  ['wifi_off', $r('app.media.ic_wifi')],
  ['smartphone', $r('app.media.ic_antenna')],
  ['tablet', $r('app.media.ic_square_terminal')],
  ['monitor', $r('app.media.ic_server')],
  ['bot', $r('app.media.ic_cpu')],
  ['cpu', $r('app.media.ic_cpu')],
  ['database', $r('app.media.ic_database')],
  ['shield', $r('app.media.ic_shield')],
  ['list', $r('app.media.ic_list')],
  ['palette', $r('app.media.ic_palette')],
  ['sun', $r('app.media.ic_sun')],
  ['moon', $r('app.media.ic_moon')],
  ['language', $r('app.media.ic_globe')],
  ['save', $r('app.media.ic_save')],
  ['wrench', $r('app.media.ic_settings')],
  ['layout', $r('app.media.ic_layout_grid')],
  ['sliders', $r('app.media.ic_sliders_horizontal')],
  ['radio', $r('app.media.ic_radio')],
  ['radio_selected', $r('app.media.ic_circle_dot')],
  ['checkbox', $r('app.media.ic_toggle_left')],
  ['checkbox_selected', $r('app.media.ic_check_square')],
]);

/** 图标名 → Resource 映射 */
export function iconRes(name: string): Resource {
  const r = ICON.get(name);
  return r ?? $r('app.media.ic_download');
}

/** 安全弹出 Toast */
export function safeToast(ui: UIContext, message: string): void {
  try {
    ui.getPromptAction().showToast({ message });
  } catch (e) {
    console.warn(`[UI] showToast failed: ${(e as Error)?.message ?? e}`);
  }
}

/** 按钮修饰器（通过 buttonModify 设置内部宽度） */
export class ActionButtonModifier implements AttributeModifier<ButtonModifier> {
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
export class ImmersionButtonModifier implements AttributeModifier<ButtonModifier> {
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
      .fontColor(this.fontColor);
  }
}
