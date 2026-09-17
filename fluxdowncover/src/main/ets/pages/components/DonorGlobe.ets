/**
 * 打赏榜单 - 静态卡片
 */

interface Donor {
  name: string;
  amount: number;
}

@Component
export struct DonorGlobe {
  private donors: Donor[] = [
    { name: '松柏', amount: 20 }
  ];

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Column() {
        Text('松柏')
          .fontSize(16)
          .fontColor(Color.White)
          .fontWeight(FontWeight.Bold)
        Text('¥20')
          .fontSize(12)
          .fontColor('#FFD700')
          .margin({ top: 4 })
      }
      .padding({ left: 24, right: 24, top: 16, bottom: 16 })
      .backgroundColor('#22FFFFFF')
      .borderRadius(40)
    }
    .width('100%')
    .height('100%')
  }
}
