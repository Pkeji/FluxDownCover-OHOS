import dataPreferences from '@ohos.data.preferences';
import { common } from '@kit.AbilityKit';

/**
 * Lightweight key-value persistence for app settings using HarmonyOS Preferences.
 * Survives app kill / background cleanup.
 * 读写均显式消化异常（满足 ArkTS 异常处理规范），失败时回退默认值、不致崩溃。
 */
export class SettingsStore {
  private static instance: SettingsStore | null = null;
  private prefs: dataPreferences.Preferences | null = null;
  private readonly STORE_NAME = 'fluxdown_settings';

  static getInstance(): SettingsStore {
    if (!SettingsStore.instance) {
      SettingsStore.instance = new SettingsStore();
    }
    return SettingsStore.instance;
  }

  async init(context: common.UIAbilityContext): Promise<void> {
    try {
      this.prefs = await dataPreferences.getPreferences(context, this.STORE_NAME);
    } catch (e) {
      console.warn(`[SettingsStore] init failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async getString(key: string, defaultValue: string): Promise<string> {
    if (!this.prefs) return defaultValue;
    try {
      return await this.prefs.get(key, defaultValue) as string;
    } catch (e) {
      console.warn(`[SettingsStore] getString(${key}) failed: ${(e as Error)?.message ?? e}`);
      return defaultValue;
    }
  }

  async getBoolean(key: string, defaultValue: boolean): Promise<boolean> {
    if (!this.prefs) return defaultValue;
    try {
      return await this.prefs.get(key, defaultValue) as boolean;
    } catch (e) {
      console.warn(`[SettingsStore] getBoolean(${key}) failed: ${(e as Error)?.message ?? e}`);
      return defaultValue;
    }
  }

  async getNumber(key: string, defaultValue: number): Promise<number> {
    if (!this.prefs) return defaultValue;
    try {
      return await this.prefs.get(key, defaultValue) as number;
    } catch (e) {
      console.warn(`[SettingsStore] getNumber(${key}) failed: ${(e as Error)?.message ?? e}`);
      return defaultValue;
    }
  }

  async put(key: string, value: string | boolean | number): Promise<void> {
    if (!this.prefs) return;
    try {
      await this.prefs.put(key, value);
      await this.prefs.flush();
    } catch (e) {
      console.warn(`[SettingsStore] put(${key}) failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
