import { Palette, palette, iconRes, safeToast, RADIUS_CARD, RADIUS_SHEET, MATERIAL_BORDER_WIDTH, materialBorder } from './SharedUI';
import { DownloadViewModel } from '../../viewmodel/DownloadViewModel';
import { formatBytes, formatDateTime } from '../../utils/common';
import { PRIVACY_APP_NAME, PRIVACY_SUMMARY, PRIVACY_SECTIONS, PRIVACY_UPDATE_DATE } from '../../utils/PrivacyPolicy';
import AuthorAvatar from './AuthorAvatar';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common, Want } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import router from '@ohos.router';
import { resourceManager } from '@kit.LocalizationKit';
import { fileUri } from '@kit.CoreFileKit';
import { bundleManager } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';

interface OssAttribution {
  name: string;
  version: string;
  role: string;
  author: string;
  license: string;
  repoUrl: string;
  avatarUrl: string;
}

interface DonorItem {
  name: string;
  amount: number;
}

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

const SELF_SOURCE_URL: string = 'https://github.com/Pkeji/FluxDownCover-OHOS';

@ComponentV2
struct AboutContent {
  @Param vm: DownloadViewModel = new DownloadViewModel();
  @Param onCheckUpdate?: () => void = undefined;
  @Param onViewPrivacy?: () => void = undefined;
  @Param isCheckingUpdate: boolean = false;
  @Param checkUpdateStatus: string = '';

  // 双击版本号复制日志
  @Local lastVersionClick: number = 0;
  @Local sheetVisible: boolean = false;
  @Local activeSheet: string = ''; // 'qq' | 'oss' | 'donate'
  // 卡片按压动效
  @Local pressKey: string = '';

  pressScale(key: string): number {
    return this.pressKey === key ? 0.96 : 1;
  }

  pressDown(key: string): void {
    this.pressKey = key;
  }

  pressUp(): void {
    this.pressKey = '';
  }

  @Computed
  get p(): Palette {
    return palette(this.vm.theme, this.vm.colorScheme);
  }

  build() {
    Column() {
      Scroll() {
        Column() {
          // ── 居中 logo + 名称版本（对齐 1.2.3.66：80×80 圆角20，顶部留 36） ──
          Column() {
            Image($r('app.media.app_icon'))
              .width(80).height(80)
              .borderRadius(20)
              .margin({ bottom: 12 })

            Text('FluxDown Cover').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.p.text)
            Text(`v${this.vm.appVersion}`).fontSize(14).fontColor(this.p.textSecondary).margin({ top: 4 })
              .onClick(() => {
                const now = Date.now();
                if (now - this.lastVersionClick < 500) {
                  this.vm.copyLogs();
                }
                this.lastVersionClick = now;
              })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Center)
          .padding({ top: 116, bottom: 28 })

          // ── 关于本应用（正文 + 支持协议） ──
          Column() {
            Text('关于本应用').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.p.text)
              .width('100%')
            Text('FluxDown Cover 是一款多协议下载管理器，支持 HTTP/HTTPS、FTP、HLS/DASH 流媒体、BitTorrent P2P、eD2K 网络及迅雷/快车/旋风专用链接。基于 HarmonyOS NEXT 原生开发，提供流畅的下载体验与任务管理功能。')
              .fontSize(14).fontColor(this.p.textSecondary).lineHeight(22).margin({ top: 10 })
              .width('100%')
          }
          .width('100%')
          .padding(20)
          .backgroundColor(this.p.surface)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(RADIUS_CARD)
          .margin({ left: 16, right: 16, bottom: 12 })

          // ── 功能入口：每张独立卡片，图标随主题色 ──
          this.SettingRow('update', '检查更新', 'aboutUpdate')
          this.SettingRow('github', '访问仓库', 'aboutRepo')
          this.SettingRow('heart', '开源致谢', 'aboutOss')
          this.SettingRow('donate', '投喂开发者', 'aboutDonate')
          this.SettingRow('qq', '官方交流群', 'aboutQq')
          this.SettingRow('shield', '隐私政策', 'aboutPrivacy')

          // ── 版权 ──
          Text('© 2026 FluxDown Cover for HarmonyOS')
            .fontSize(12).fontColor(this.p.textSecondary)
            .width('100%').textAlign(TextAlign.Center).margin({ top: 16, bottom: 8 })
        }
        .width('100%')
      }
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .width('100%')
      .contentEndOffset((AppStorage.get<number>('fluxdown_naviIndicatorHeight') ?? 0) + 52 + 16 + 16)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.bg)
    .bindSheet(this.sheetVisible, this.SheetContent(), {
      detents: [SheetSize.MEDIUM],
      backgroundColor: this.p.surface,
      showClose: false,
      onDisappear: () => {
        this.sheetVisible = false;
        this.activeSheet = '';
      }
    })
  }

  /** 统一关闭按钮：对齐新建下载弹窗——32×32 圆形毛玻璃，深色模式适配 */
  @Builder
  CloseXBtn() {
    Stack({ alignContent: Alignment.Center }) {
      Column()
        .width(32).height(32)
        .borderRadius(16)
        .backgroundColor(this.p.dark ? '#F23A3A3A' : '#F2F3F5')
        .border({ width: 0.5, color: this.p.dark ? '#33FFFFFF' : '#1A000000' })
      Image(iconRes('x'))
        .width(16).height(16).fillColor(this.p.text)
    }
    .onClick(() => { this.closeSheet(); })
  }

  /** 独立功能卡片：对齐 1.2.3.66 原版——图标18、文字16、箭头16、padding16、卡片间距16 */
  @Builder
  SettingRow(icon: string, label: string, key: string) {
    Row() {
      Image(iconRes(icon)).width(18).height(18).objectFit(ImageFit.Contain).fillColor(this.p.primary)
        .margin({ right: 10 })
      Text(label).fontSize(16).fontColor(this.p.text).layoutWeight(1)
      Image(iconRes('chevron_right')).width(16).height(16).fillColor(this.p.textSecondary)
        .margin({ left: 8 })
    }
    .width('100%')
    .padding(16)
    .backgroundColor(this.p.surface)
    .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
    .borderRadius(RADIUS_CARD)
    .margin({ left: 16, right: 16, bottom: 16 })
    .scale({ x: this.pressScale(key), y: this.pressScale(key) })
    .animation({ duration: 120, curve: Curve.Friction })
    .onTouch((e: TouchEvent) => {
      if (e.type === TouchType.Down) { this.pressDown(key); }
      else if (e.type === TouchType.Up || e.type === TouchType.Cancel) { this.pressUp(); }
    })
    .onClick(() => {
      if (key === 'aboutUpdate') {
        this.onCheckUpdate?.();
      } else if (key === 'aboutRepo') {
        this.vm.openUrl(SELF_SOURCE_URL);
      } else if (key === 'aboutOss') {
        this.activeSheet = 'oss'; this.sheetVisible = true;
      } else if (key === 'aboutDonate') {
        this.activeSheet = 'donate'; this.sheetVisible = true;
      } else if (key === 'aboutQq') {
        this.activeSheet = 'qq'; this.sheetVisible = true;
      } else if (key === 'aboutPrivacy') {
        this.onViewPrivacy?.();
      }
    })
  }

  /** 支持协议行：主题色图标 + 名称 */
  @Builder
  ProtocolRow(icon: string, name: string) {
    Row({ space: 12 }) {
      Image(iconRes(icon)).width(20).height(20).fillColor(this.p.primary)
      Text(name).fontSize(14).fontColor(this.p.text)
    }
    .width('100%')
    .padding({ top: 12, bottom: 12 })
  }

  /** 统一关闭弹窗：同时清空 activeSheet，避免 bindSheet 状态卡死再打不开 */
  closeSheet(): void {
    this.sheetVisible = false;
    this.activeSheet = '';
  }

  /** 照令牌项目：showAssetsCreationDialogEx 系统弹窗保存，无需权限 */
  private async saveDonateImage(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    const path = ctx.filesDir + '/FluxDownCover_donate_' + Date.now().toString() + '.jpg';
    let completed = false;
    try {
      const rawData = await ctx.resourceManager.getRawFileContent('donate.jpg');
      const file = fs.openSync(path,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, rawData.buffer);
      } finally {
        fs.closeSync(file);
      }
      const sourceUris: string[] = [fileUri.getUriFromPath(path)];
      const settings: photoAccessHelper.CreationSetting[] = [{
        title: 'FluxDownCover_收款码',
        fileNameExtension: 'jpg',
        photoType: photoAccessHelper.PhotoType.IMAGE
      }];
      const savedUris: string[] =
        await photoAccessHelper.getPhotoAccessHelper(ctx)
          .showAssetsCreationDialogEx(sourceUris, settings);
      if (savedUris.length === 0) {
        promptAction.showToast({ message: '已取消' });
        return;
      }
      // 关键：把临时文件内容真正复制到图库 uri
      let copied = false;
      try {
        fs.copyFileSync(path, savedUris[0]);
        copied = true;
      } catch (e) {
        // 回退：流式复制
        try {
          const stat = fs.statSync(path);
          const buf = new ArrayBuffer(stat.size);
          const src = fs.openSync(path, fs.OpenMode.READ_ONLY);
          fs.readSync(src.fd, buf);
          fs.closeSync(src);
          const dst = fs.openSync(savedUris[0], fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
          fs.writeSync(dst.fd, buf);
          fs.closeSync(dst);
          copied = true;
        } catch (e2) {
        }
      }
      if (!copied) {
        promptAction.showToast({ message: '保存图片失败' });
        return;
      }
      completed = true;
      promptAction.showToast({ message: '图片已保存到图库' });
    } catch (err) {
      promptAction.showToast({ message: '保存图片失败' });
    } finally {
      try { fs.unlinkSync(path); } catch (e) {}
    }
  }

  /** 长按图片弹保存确认 */
  private showDonateActions(): void {
    this.getUIContext().showAlertDialog({
      title: '保存收款码',
      message: '将这张收款码保存到系统相册？',
      primaryButton: { value: '取消', action: () => { } },
      secondaryButton: { value: '保存', fontColor: this.p.primary, action: () => { this.saveDonateImage(); } }
    });
  }

  @Builder
  SheetContent() {
    Column() {
      if (this.activeSheet === 'qq') {
        this.QqGroupSheet()
      } else if (this.activeSheet === 'oss') {
        this.OssSheet()
      } else if (this.activeSheet === 'donate') {
        this.DonateSheet()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.surface)
  }

  /** 打开QQ群：检测QQ，有QQ直接跳转，没QQ用浏览器打开 */
  private openQQGroup(): void {
    const groupNumber = '1121565536';
    const h5Url = 'https://qun.qq.com/universal-share/share?ac=1&authKey=Jcxm9Kgi22K0O%2FPwws6chnIVQSjKNpEAcfq0tADTNJ1EwMFzohA4YOlXuwOz%2B8xz&busi_data=eyJncm91cENvZGUiOiIxMTIxNTY1NTM2IiwidG9rZW4iOiJwSzBkNTFKSGFGbXRjZk5pOFE0aGtQSDZSMHN0MnExWVJGcDR6WlgzeE5VcEJ0M3JTcnIrZHNlc0kzK3RRV1lJIiwidWluIjoiMTAxMjQ0MzU1NyJ9&data=Hvy3TedB6d7PgopsRuZzjY00d9OYpE_-5ASDCIym0LPHvCNBY6s7Q6IAdChl4iYB5L1L6r7YVZ4fQz0Dio5PGQ&svctype=4&tempid=h5_group_info';
    const qqScheme = `mqqapi://card/show_pslcard?src_type=internal&version=1&uin=${groupNumber}&card_type=group&source=qrcode`;
    const ctx = getContext(this) as common.UIAbilityContext;
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
      ctx.startAbility(want).catch(() => {
        const h5Want: Want = { uri: h5Url };
        ctx.startAbility(h5Want);
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
        const h5Want: Want = { bundleName: browserBundleName, uri: h5Url };
        ctx.startAbility(h5Want).catch(() => {
          ctx.startAbility({ uri: h5Url });
        });
      } else {
        pasteboard.getSystemPasteboard().setData(
          pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, h5Url));
        promptAction.showToast({ message: '群链接已复制，请在浏览器中粘贴打开' });
      }
    }
  }

  /** 复制群号 */
  private copyQQGroup(): void {
    pasteboard.getSystemPasteboard().setData(
      pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, '1121565536'));
    promptAction.showToast({ message: '群号 1121565536 已复制' });
  }

  @Builder
  QqGroupSheet() {
    Column() {
      Row() {
        Text('加入官方交流群').fontSize(18).fontWeight(FontWeight.Bold).fontColor(this.p.text)
        Blank()
        this.CloseXBtn()
      }
      .width('100%')
      .padding(16)

      // QQ group code image
      Column() {
        Image($rawfile('qq_group.jpg'))
          .width(280)
          .height(280)
          .objectFit(ImageFit.Cover)
          .borderRadius(16)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Center)
      .padding({ left: 16, right: 16, top: 8, bottom: 8 })

      // 操作按钮：复制群号 / 加入QQ群
      Row({ space: 12 }) {
        Button('复制群号').fontSize(14).fontColor(this.p.primary)
          .backgroundColor(this.p.surface)
          .border({ width: MATERIAL_BORDER_WIDTH, color: materialBorder(this.p.dark) })
          .borderRadius(22).height(42)
          .layoutWeight(1)
          .onClick(() => {
            this.copyQQGroup();
          })
        Button('加入QQ群').fontSize(14).fontColor(this.p.onPrimary)
          .backgroundColor(this.p.primarySolid).borderRadius(22).height(42)
          .layoutWeight(1)
          .onClick(() => {
            this.openQQGroup();
          })
      }
      .width('100%')
      .padding({ left: 24, right: 24, top: 12, bottom: 24 })
    }
    .width('100%')
    .backgroundColor(this.p.surface)
  }

  @Builder
  OssSheet() {
    Column() {
      Row() {
        Text('开源致谢').fontSize(18).fontWeight(FontWeight.Bold).fontColor(this.p.text)
        Blank()
        this.CloseXBtn()
      }
      .width('100%')
      .padding(16)

      Text('本项目使用了以下开源组件和资源，谨致谢忱。')
        .fontSize(13).fontColor(this.p.textSecondary).padding({ left: 16, right: 16, bottom: 12 })

      List() {
        ForEach(OSS_ATTRIBUTIONS, (attribution: OssAttribution) => {
          ListItem() {
            this.OssRow(attribution)
          }
        })
      }
      .edgeEffect(EdgeEffect.Spring)
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .backgroundColor(this.p.surface)
  }

  @Builder
  OssRow(attribution: OssAttribution) {
    Row() {
      AuthorAvatar({
        url: attribution.avatarUrl,
        name: attribution.author,
        avatarSize: 40,
        bg: this.p.surface,
        fg: this.p.text
      })
      .margin({ right: 12 })

      Column() {
        Text(attribution.name).fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.p.text)
        Row() {
          Text(attribution.license).fontSize(11).fontColor(this.p.primary)
            .margin({ right: 6 })
          Text(attribution.version).fontSize(11).fontColor(this.p.textSecondary)
        }
        .margin({ top: 4 })
        Text(attribution.role).fontSize(12).fontColor(this.p.textSecondary).margin({ top: 2 }).lineHeight(16)
        Text(attribution.author).fontSize(11).fontColor(this.p.textSecondary).margin({ top: 2 })
        if (attribution.repoUrl) {
          Text(attribution.repoUrl).fontSize(11).fontColor(this.p.primary).margin({ top: 2 })
            .onClick(() => { this.vm.openUrl(attribution.repoUrl); })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .border({ width: { bottom: 0.5 }, color: this.p.border })
  }

  @Builder
  DonateSheet() {
    Column() {
      Row() {
        Text('投喂开发者').fontSize(18).fontWeight(FontWeight.Bold).fontColor(this.p.text)
        Blank()
        this.CloseXBtn()
      }
      .width('100%')
      .padding(16)

      Text('如果这个下载器帮到了你，欢迎请作者喝杯咖啡')
        .fontSize(13).fontColor(this.p.textSecondary)
        .width('100%')
        .padding({ left: 16, right: 16, bottom: 8 })

      Image($rawfile('donate.jpg'))
        .width(280)
        .borderRadius(16)
        .objectFit(ImageFit.Contain)
        .margin({ bottom: 16 })

      Row({ space: 6 }) {
        Image(iconRes('download'))
          .width(14).height(14)
          .fillColor(Color.White)
        Text('保存到相册').fontSize(13).fontColor(Color.White)
      }
      .padding({ left: 20, right: 20, top: 10, bottom: 10 })
      .backgroundColor(this.p.primary)
      .borderRadius(20)
      .onClick(() => { this.saveDonateImage(); })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.p.surface)
  }
}

export default AboutContent;
