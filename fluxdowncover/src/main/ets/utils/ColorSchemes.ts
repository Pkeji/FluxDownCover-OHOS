/**
 * Accent color schemes: 13 classic FluxDown Cover colors + 5 Morandi low-saturation colors
 * (ported from OpenAuthenticator's design system).
 * Each scheme provides a primary color and a set of semantic colors.
 * The base palette (bg, surface, text) is still controlled by light/dark mode;
 * these schemes only override the accent/primary color.
 */
export interface ColorScheme {
  id: string;
  name: string;
  group?: string;    // 'classic' | 'morandi'（用于设置页分组展示）
  primary: string;   // main accent（浅色模式）
  primaryDark: string; // darker variant for pressed states
  darkPrimary?: string; // 深色模式专用主色（莫兰迪色明暗各一档；缺省复用 primary）
  onPrimary?: string;   // primary 背景上的前景色（缺省白字，莫兰迪浅色用深字保证对比度）
  success: string;
  warning: string;
  error: string;
}

export const COLOR_SCHEMES: ColorScheme[] = [
  // 注意：classic 主色经过 palette() 的 ensureContrast 压缩后只保留 hue+saturation，
  // 原先靠"明度"区分的配色会趋同（紫/紫罗兰仅 8.5、红/玫瑰 21.8）。
  // 下列取值是在"保持明快(L 0.62-0.78 / S 0.75-0.95)"约束下优化色相与饱和度得到的，
  // 使压缩后最小两两 RGB 距离从 8.5 提升到 48.3。改动主色后请勿随意微调，需重新校验区分度。
  { id: 'cyan',    name: '青色',   group: 'classic', primary: '#42E2FA', primaryDark: '#06D0EE', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'blue',    name: '蓝色',   group: 'classic', primary: '#55A8E7', primaryDark: '#1E87D6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'purple',  name: '紫色',   group: 'classic', primary: '#CA9DF1', primaryDark: '#A85FE8', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'pink',    name: '粉色',   group: 'classic', primary: '#FA42B7', primaryDark: '#EE069A', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'red',     name: '红色',   group: 'classic', primary: '#FA4261', primaryDark: '#EE062D', success: '#22C55E', warning: '#F59E0B', error: '#DC2626' },
  { id: 'orange',  name: '橙色',   group: 'classic', primary: '#F07D4C', primaryDark: '#E25113', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'amber',   name: '琥珀',   group: 'classic', primary: '#E7B155', primaryDark: '#D6921E', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'green',   name: '绿色',   group: 'classic', primary: '#55E755', primaryDark: '#1ED61E', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'teal',    name: '青绿',   group: 'classic', primary: '#42FAC3', primaryDark: '#06EEA9', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'indigo',  name: '靛蓝',   group: 'classic', primary: '#92A7FC', primaryDark: '#4D6FFA', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'violet',  name: '紫罗兰', group: 'classic', primary: '#6955E7', primaryDark: '#371ED6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'fuchsia', name: '紫红',   group: 'classic', primary: '#D355E7', primaryDark: '#BD1ED6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'rose',    name: '玫瑰',   group: 'classic', primary: '#EC799D', primaryDark: '#E33A6F', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  // ── 莫兰迪低饱和组（参考 OpenAuthenticator 设计系统）──
  { id: 'morandi-cream',    name: '奶油黄',   group: 'morandi', primary: '#D6B75D', primaryDark: '#C4A44E', darkPrimary: '#E4CA7B', onPrimary: '#1A1A1A', success: '#5B8A72', warning: '#B58B5A', error: '#B05A5A' },
  { id: 'morandi-sage',     name: '鼠尾草绿', group: 'morandi', primary: '#72A28B', primaryDark: '#5E8A76', darkPrimary: '#8DBBA5', onPrimary: '#FFFFFF', success: '#4E7D66', warning: '#A87E52', error: '#A85454' },
  { id: 'morandi-mist',     name: '雾霾蓝',   group: 'morandi', primary: '#6F98AE', primaryDark: '#5A8096', darkPrimary: '#8AB4C9', onPrimary: '#FFFFFF', success: '#4E7D66', warning: '#A87E52', error: '#A85454' },
  { id: 'morandi-rose',     name: '灰豆沙粉', group: 'morandi', primary: '#CE96A4', primaryDark: '#B77C8B', darkPrimary: '#DDAEB9', onPrimary: '#1A1A1A', success: '#5B8A72', warning: '#B58B5A', error: '#B05A5A' },
  { id: 'morandi-charcoal', name: '清透炭黑', group: 'morandi', primary: '#292C30', primaryDark: '#1B1E21', darkPrimary: '#73777D', onPrimary: '#FFFFFF', success: '#4E7D66', warning: '#A87E52', error: '#A85454' },
];

export function getScheme(id: string): ColorScheme {
  return COLOR_SCHEMES.find(s => s.id === id) ?? COLOR_SCHEMES[0];
}
