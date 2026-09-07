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
  { id: 'cyan',    name: '青色',   group: 'classic', primary: '#60A5FA', primaryDark: '#3B82F6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'blue',    name: '蓝色',   group: 'classic', primary: '#3B82F6', primaryDark: '#2563EB', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'purple',  name: '紫色',   group: 'classic', primary: '#A78BFA', primaryDark: '#8B5CF6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'pink',    name: '粉色',   group: 'classic', primary: '#F472B6', primaryDark: '#EC4899', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'red',     name: '红色',   group: 'classic', primary: '#F87171', primaryDark: '#EF4444', success: '#22C55E', warning: '#F59E0B', error: '#DC2626' },
  { id: 'orange',  name: '橙色',   group: 'classic', primary: '#FB923C', primaryDark: '#F97316', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'amber',   name: '琥珀',   group: 'classic', primary: '#FBBF24', primaryDark: '#F59E0B', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'green',   name: '绿色',   group: 'classic', primary: '#4ADE80', primaryDark: '#22C55E', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'teal',    name: '青绿',   group: 'classic', primary: '#2DD4BF', primaryDark: '#14B8A6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'indigo',  name: '靛蓝',   group: 'classic', primary: '#818CF8', primaryDark: '#6366F1', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'violet',  name: '紫罗兰', group: 'classic', primary: '#C4B5FD', primaryDark: '#A78BFA', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'fuchsia', name: '紫红',   group: 'classic', primary: '#E879F9', primaryDark: '#D946EF', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'rose',    name: '玫瑰',   group: 'classic', primary: '#FDA4AF', primaryDark: '#FB7185', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
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
