/**
 * 13 accent color schemes ported from FluxDown's theme system.
 * Each scheme provides a primary color and a set of semantic colors.
 * The base palette (bg, surface, text) is still controlled by light/dark mode;
 * these schemes only override the accent/primary color.
 */
export interface ColorScheme {
  id: string;
  name: string;
  primary: string;   // main accent
  primaryDark: string; // darker variant for pressed states
  success: string;
  warning: string;
  error: string;
}

export const COLOR_SCHEMES: ColorScheme[] = [
  { id: 'cyan',    name: '青色',   primary: '#60A5FA', primaryDark: '#3B82F6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'blue',    name: '蓝色',   primary: '#3B82F6', primaryDark: '#2563EB', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'purple',  name: '紫色',   primary: '#A78BFA', primaryDark: '#8B5CF6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'pink',    name: '粉色',   primary: '#F472B6', primaryDark: '#EC4899', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'red',     name: '红色',   primary: '#F87171', primaryDark: '#EF4444', success: '#22C55E', warning: '#F59E0B', error: '#DC2626' },
  { id: 'orange',  name: '橙色',   primary: '#FB923C', primaryDark: '#F97316', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'amber',   name: '琥珀',   primary: '#FBBF24', primaryDark: '#F59E0B', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'green',   name: '绿色',   primary: '#4ADE80', primaryDark: '#22C55E', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'teal',    name: '青绿',   primary: '#2DD4BF', primaryDark: '#14B8A6', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'indigo',  name: '靛蓝',   primary: '#818CF8', primaryDark: '#6366F1', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'violet',  name: '紫罗兰', primary: '#C4B5FD', primaryDark: '#A78BFA', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'fuchsia', name: '紫红',   primary: '#E879F9', primaryDark: '#D946EF', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
  { id: 'rose',    name: '玫瑰',   primary: '#FDA4AF', primaryDark: '#FB7185', success: '#22C55E', warning: '#F59E0B', error: '#EF4444' },
];

export function getScheme(id: string): ColorScheme {
  return COLOR_SCHEMES.find(s => s.id === id) ?? COLOR_SCHEMES[0];
}
