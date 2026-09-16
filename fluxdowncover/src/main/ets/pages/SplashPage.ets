import { window, LengthMetrics } from '@kit.ArkUI';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import dataPreferences from '@ohos.data.preferences';
import {
  BlurStrategy,
  HdsNavigation,
  HdsNavigationMenuContentOptions,
  HdsNavigationTitleMode,
  IconStyleMode,
  ScrollEffectType,
  TitleBarStyleOptions
} from '@kit.UIDesignKit';
import { getScheme } from '../utils/ColorSchemes';
import { PRIVACY_APP_NAME, PRIVACY_SUMMARY, PRIVACY_SECTIONS, PRIVACY_UPDATE_DATE, PrivacySection } from '../utils/PrivacyPolicy';

/**
 * 应用启动页（Splash）。
 * 跟随当前颜色模式（浅色白底深字 / 深色黑底亮字）+ Logo 入场动画 + 应用名，
 * 约 1.5s 后检查隐私协议：已同意则无栈替换到主页；未同意则以半模态弹出协议全文
 * （界面直接借鉴「令牌项目 openauth-ref」的 UserAgreementSheet：HdsNavigation 标题栏 +
 * 大标题/日期/强调框 + 编号章节 + 页脚），底部固定「不同意 / 同意」双按钮，
 * 同意后才进入主页，拒绝则退出应用。
 */
@Entry
@Component
struct SplashPage {
  @State private isDark: boolean = false;
  @State private accent: string = '#42E2FA';
  @State private logoScale: number = 0.84;
  @State private logoOpacity: number = 0;
  @State private logoOffset: number = 18;
  @State private titleOpacity: number = 0;
  @State private titleOffset: number = 14;
  @State private subOpacity: number = 0;
  @State private footOpacity: number = 0;
  @State private showPrivacyDialog: boolean = false;
  private agreementScroller: Scroller = new Scroller();
  private navigated: boolean = false;

  aboutToAppear(): void {
    let sysDark: boolean = false;
    try {
      const cfgCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      sysDark = cfgCtx.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    } catch (_e) {
      sysDark = false;
    }
    this.isDark = sysDark;
    this.applyStatusBar();
    try {
      const prefCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      dataPreferences.getPreferences(prefCtx, 'fluxdown_settings').then((prefs) => {
        prefs.get('themeMode', 'light').then((v) => {
          const mode: string = v as string;
          const finalDark: boolean = mode === 'dark' ? true : (mode === 'system' ? sysDark : false);
          if (finalDark !== this.isDark) {
            this.isDark = finalDark;
            this.applyStatusBar();
          }
          prefs.get('colorScheme', 'cyan').then((cv) => {
            const sc = getScheme(cv as string);
            this.accent = finalDark ? (sc.darkPrimary ?? sc.primary) : sc.primary;
          }).catch(() => {});
        }).catch(() => {});
      }).catch(() => {});
    } catch (_e) {}

    setTimeout(() => {
      this.getUIContext().animateTo({ duration: 620, curve: Curve.Friction, iterations: 1, playMode: PlayMode.Normal }, () => {
        this.logoScale = 1;
        this.logoOpacity = 1;
        this.logoOffset = 0;
      });
    }, 60);
    setTimeout(() => {
      this.getUIContext().animateTo({ duration: 480, curve: Curve.EaseOut }, () => {
        this.titleOpacity = 1;
        this.titleOffset = 0;
      });
    }, 240);
    setTimeout(() => {
      this.getUIContext().animateTo({ duration: 480, curve: Curve.EaseOut }, () => {
        this.subOpacity = 1;
      });
    }, 380);
    setTimeout(() => {
      this.getUIContext().animateTo({ duration: 480, curve: Curve.EaseOut }, () => {
        this.footOpacity = 1;
      });
    }, 520);
    setTimeout(() => {
      this.checkPrivacyAndNavigate();
    }, 1500);
  }

  private async checkPrivacyAndNavigate(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      const prefs = await dataPreferences.getPreferences(context, 'fluxdown_settings');
      const agreed = await prefs.get('privacyAgreed', false);
      if (agreed === true) {
        this.goMain();
      } else {
        this.showPrivacyDialog = true;
      }
    } catch (e) {
      this.showPrivacyDialog = true;
    }
  }

  private async agreePrivacy(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      const prefs = await dataPreferences.getPreferences(context, 'fluxdown_settings');
      await prefs.put('privacyAgreed', true);
      await prefs.flush();
      context.eventHub.emit('privacyAgreed');
      this.showPrivacyDialog = false;
      this.goMain();
    } catch (e) {
      console.error('[SplashPage] agreePrivacy failed:', JSON.stringify(e));
    }
  }

  private refusePrivacy(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      context.terminateSelf();
    } catch (e) {
      console.error('[SplashPage] terminateSelf failed:', JSON.stringify(e));
    }
  }

  private goMain(): void {
    if (this.navigated) {
      return;
    }
    this.navigated = true;
    this.getUIContext().getRouter().replaceUrl({ url: 'pages/Index' }).catch((_e: Error) => {
      this.navigated = false;
    });
  }

  private applyStatusBar(): void {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      window.getLastWindow(ctx).then((win: window.Window) => {
        win.setWindowSystemBarProperties({
          statusBarColor: '#00000000',
          isStatusBarLightIcon: this.isDark,
          statusBarContentColor: this.isDark ? '#FFEEEEEE' : '#FF000000'
        });
      }).catch((_e: Error) => {});
    } catch (_e) {}
  }

  // ──────────────────────────── 配色辅助（色值直接采用令牌项目 openauth-ref） ────────────────────────────

  private primaryTextColor(): string {
    return this.isDark ? '#EEEEEE' : '#1A1A1A';
  }

  private secondaryTextColor(): string {
    return this.isDark ? '#B8B8B8' : '#666666';
  }

  private dividerColor(): string {
    return this.isDark ? '#444444' : '#E6E6E6';
  }

  private sheetControlBackgroundColor(): string {
    return this.isDark ? '#F23A3A3A' : '#F2F3F5';
  }

  private sheetSurfaceBackgroundColor(): ResourceColor {
    return this.isDark ? '#191919' : '#FFFFFF';
  }

  private sheetCloseMenu(): HdsNavigationMenuContentOptions {
    return {
      value: [
        {
          content: {
            icon: $r('sys.symbol.xmark'),
            label: '关闭',
            type: IconStyleMode.SMALL,
            action: () => { this.refusePrivacy(); }
          }
        }
      ],
      maxCount: 1
    };
  }

  private sheetTitleBarStyle(): TitleBarStyleOptions {
    return {
      scrollEffectOpts: {
        enableScrollEffect: false,
        scrollEffectType: ScrollEffectType.GRADIENT_BLUR
      },
      blurStrategy: BlurStrategy.ADAPTIVE,
      originalStyle: {
        backgroundStyle: { backgroundColor: '#00ffffff' },
        contentStyle: {
          titleStyle: { mainTitleColor: this.primaryTextColor() },
          menuStyle: {
            backgroundColor: this.sheetControlBackgroundColor(),
            iconColor: this.primaryTextColor()
          },
          backIconStyle: {
            backgroundColor: this.sheetControlBackgroundColor(),
            iconColor: this.primaryTextColor()
          }
        }
      },
      scrollEffectStyle: {
        backgroundStyle: { backgroundColor: '#00ffffff' },
        contentStyle: {
          titleStyle: { mainTitleColor: this.primaryTextColor() },
          menuStyle: {
            backgroundColor: this.sheetControlBackgroundColor(),
            iconColor: this.primaryTextColor()
          },
          backIconStyle: {
            backgroundColor: this.sheetControlBackgroundColor(),
            iconColor: this.primaryTextColor()
          }
        }
      }
    };
  }

  // ──────────────────────────── 协议界面 Builder（照搬令牌项目 UserAgreementSheet 结构） ────────────────────────────

  @Builder
  BrandBlock() {
    Column() {
      Stack() {
        Image($r('app.media.foreground'))
          .width(this.isDark ? 104 : 120)
          .height(this.isDark ? 104 : 120)
          .borderRadius(this.isDark ? 22 : 0)
      }
      .width(120)
      .height(120)
      .margin({ bottom: 30 })
      .borderRadius(26)
      .backgroundColor(this.isDark ? '#FFFFFF' : Color.Transparent)
      .scale({ x: this.logoScale, y: this.logoScale })
      .opacity(this.logoOpacity)
      .translate({ y: this.logoOffset })

      Text('FluxDown Cover')
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.isDark ? '#EEEEEE' : '#1A1A1A')
        .letterSpacing(0.6)
        .opacity(this.titleOpacity)
        .translate({ y: this.titleOffset })

      Text('多协议 · 原生下载管理器')
        .fontSize(14)
        .fontColor(this.isDark ? '#9CA3AF' : '#757575')
        .opacity(this.subOpacity * 0.92)
        .margin({ top: 12 })
        .letterSpacing(1.2)
    }
    .justifyContent(FlexAlign.Center)
  }

  /** 隐私协议半模态：界面结构完全照搬令牌项目（openauth-ref）UserAgreementSheet */
  @Builder
  PrivacySheet() {
    HdsNavigation() {
      Column() {
        Scroll(this.agreementScroller) {
          Column() {
            this.AgreementTitle(PRIVACY_APP_NAME + ' 隐私政策')
            this.AgreementDate('更新日期：' + PRIVACY_UPDATE_DATE)
            this.AgreementNotice('请您在使用 ' + PRIVACY_APP_NAME + ' 前仔细阅读本隐私政策，尤其是以加粗方式提示的条款。点击“同意”即表示您已阅读并同意本政策。')

            this.AgreementSection(PRIVACY_SUMMARY)

            ForEach(PRIVACY_SECTIONS, (sec: PrivacySection) => {
              this.AgreementHeading(sec.title)
              this.AgreementParagraph(sec.body, false)
            }, (sec: PrivacySection) => sec.title)

            this.AgreementFooter('FluxDown Cover 开发者')
          }
          .width('100%')
          .padding({
            left: 20,
            right: 20,
            top: 10,
            bottom: 20
          })
        }
        .layoutWeight(1)
        .width('100%')
        .edgeEffect(EdgeEffect.Spring, { alwaysEnabled: true })
        .scrollBar(BarState.Off)
        .clip(false)
        .padding({ bottom: 80 })

        // 底部固定操作栏：不同意 / 同意
        Row({ space: 12 }) {
          Button('不同意')
            .type(ButtonType.Capsule)
            .fontSize(15)
            .layoutWeight(1)
            .height(44)
            .backgroundColor(this.isDark ? '#2A2A2A' : '#F5F5F5')
            .fontColor(this.isDark ? '#B0B0B0' : '#666666')
            .onClick(() => { this.refusePrivacy(); })

          Button('同意')
            .type(ButtonType.Capsule)
            .fontSize(15)
            .layoutWeight(1)
            .height(44)
            .backgroundColor(this.accent)
            .fontColor('#FFFFFF')
            .onClick(() => { this.agreePrivacy(); })
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 12, bottom: 24 })
      }
      .width('100%')
      .height('100%')
      .clip(false)
    }
    .titleMode(HdsNavigationTitleMode.MODAL)
    .titleBar({
      content: {
        title: { mainTitle: '隐私政策' },
        menu: this.sheetCloseMenu()
      },
      style: this.sheetTitleBarStyle(),
      enableComponentSafeArea: true
    })
    .bindToScrollable([this.agreementScroller])
    .hideBackButton(true)
    .width('100%')
    .height('100%')
    .backgroundColor(this.sheetSurfaceBackgroundColor())
  }

  @Builder
  AgreementTitle(text: string) {
    Text(text)
      .width('100%')
      .fontSize(22)
      .lineHeight(30)
      .fontWeight(FontWeight.Bold)
      .fontColor(this.primaryTextColor())
      .margin({ bottom: 4 })
  }

  @Builder
  AgreementDate(text: string) {
    Text(text)
      .width('100%')
      .fontSize(13)
      .lineHeight(20)
      .fontColor(this.secondaryTextColor())
  }

  @Builder
  AgreementNotice(text: string) {
    Text(text)
      .width('100%')
      .fontSize(14)
      .lineHeight(22)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.primaryTextColor())
      .padding({ left: 14, right: 14, top: 12, bottom: 12 })
      .margin({ top: 18, bottom: 4 })
      .borderRadius(12)
      .backgroundColor(this.sheetControlBackgroundColor())
      .border({ width: 1, color: this.accent })
  }

  @Builder
  AgreementSection(text: string) {
    Text(text)
      .width('100%')
      .fontSize(14)
      .lineHeight(24)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.primaryTextColor())
      .margin({ top: 18 })
  }

  @Builder
  AgreementHeading(text: string) {
    Text(text)
      .width('100%')
      .fontSize(17)
      .lineHeight(24)
      .fontWeight(FontWeight.Bold)
      .fontColor(this.primaryTextColor())
      .margin({ top: 22, bottom: 4 })
  }

  @Builder
  AgreementParagraph(text: string, emphasized: boolean) {
    Text(text)
      .width('100%')
      .fontSize(14)
      .lineHeight(24)
      .fontWeight(emphasized ? FontWeight.Medium : FontWeight.Regular)
      .fontColor(this.primaryTextColor())
      .margin({ top: 6 })
  }

  @Builder
  AgreementFooter(text: string) {
    Column({ space: 14 }) {
      Divider()
        .color(this.dividerColor())
      Text(text)
        .width('100%')
        .fontSize(13)
        .lineHeight(20)
        .fontColor(this.secondaryTextColor())
    }
    .width('100%')
    .margin({ top: 26 })
  }

  build() {
    Stack() {
      Column() {
        Blank().layoutWeight(1)
        this.BrandBlock()
        Blank().layoutWeight(1)

        Row({ space: 10 }) {
          LoadingProgress()
            .width(22)
            .height(22)
            .color(this.accent)
          Text('正在启动…')
            .fontSize(13)
            .fontColor(this.isDark ? '#9CA3AF' : '#757575')
            .opacity(0.9)
        }
        .margin({ bottom: 64 })
        .opacity(this.footOpacity)
      }
      .width('100%')
      .height('100%')
      .backgroundColor(this.isDark ? '#000000' : '#FFFFFF')
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])

      // 半模态锚点：协议全文按令牌项目方式以 HdsNavigation 半模态弹出
      Column()
        .width(1)
        .height(1)
        .opacity(0)
        .hitTestBehavior(HitTestMode.None)
        .bindSheet($$this.showPrivacyDialog, this.PrivacySheet(), {
          height: SheetSize.LARGE,
          dragBar: true,
          showClose: false,
          backgroundColor: this.sheetSurfaceBackgroundColor(),
          blurStyle: BlurStyle.COMPONENT_THIN,
          radius: LengthMetrics.vp(28),
          onDisappear: (): void => {
            // 未同意被系统关闭（下滑/返回）时，重新弹出，直到用户做出选择
            if (!this.navigated) {
              this.checkPrivacyAndNavigate();
            }
          }
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.isDark ? '#000000' : '#FFFFFF')
  }
}