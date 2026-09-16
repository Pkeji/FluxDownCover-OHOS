// ArkUI V2 状态装饰器：.ts 为独立模块、SDK 全局装饰器声明不注入，故在此做模块级类型声明（不污染全局）
declare const ObservedV2: ClassDecorator;
declare const Trace: PropertyDecorator;
/**
 * User-defined download category (FluxDown "分类管理").
 * A category groups tasks by extension rules and can override the save directory.
 */
@ObservedV2
export class DownloadCategory {
  @Trace id: string;
  @Trace name: string;
  /** Comma-separated extension rules, e.g. "mp4,mkv,avi". Empty = match all. */
  @Trace extensions: string = '';
  /** Per-category save directory (empty = use default). */
  @Trace saveDir: string = '';
  /** Higher = listed first in the category bar. */
  @Trace priority: number = 0;
  @Trace createdAt: number = Date.now();

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  /** True when the given file name matches this category's extension rules. */
  matches(fileName: string): boolean {
    const exts = this.extensions
      .split(',')
      .map(e => e.trim().toLowerCase().replace(/^\./, ''))
      .filter(e => e.length > 0);
    if (exts.length === 0) {
      return true;
    }
    const dot = fileName.lastIndexOf('.');
    if (dot < 0) {
      return false;
    }
    const ext = fileName.substring(dot + 1).toLowerCase();
    return exts.includes(ext);
  }
}
