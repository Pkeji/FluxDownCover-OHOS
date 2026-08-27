import dataPreferences from '@ohos.data.preferences';
import { common } from '@kit.AbilityKit';

/**
 * Lightweight key-value persistence for app settings using HarmonyOS Preferences.
 * Survives app kill / background cleanup.
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
    this.prefs = await dataPreferences.getPreferences(context, this.STORE_NAME);
  }

  async getString(key: string, defaultValue: string): Promise<string> {
    if (!this.prefs) return defaultValue;
    return await this.prefs.get(key, defaultValue) as string;
  }

  async getBoolean(key: string, defaultValue: boolean): Promise<boolean> {
    if (!this.prefs) return defaultValue;
    return await this.prefs.get(key, defaultValue) as boolean;
  }

  async getNumber(key: string, defaultValue: number): Promise<number> {
    if (!this.prefs) return defaultValue;
    return await this.prefs.get(key, defaultValue) as number;
  }

  async put(key: string, value: string | boolean | number): Promise<void> {
    if (!this.prefs) return;
    await this.prefs.put(key, value);
    await this.prefs.flush();
  }
}
