import { Palette, palette } from './SharedUI';

@ComponentV2
struct FilterChipComponent {
  @Param label: string = '';
  @Param selected: boolean = false;
  @Param p: Palette = palette('light');
  @Param onTap: () => void = () => {};

  build() {
    Text(this.label)
      .fontSize(14)
      .fontColor(this.selected ? this.p.onPrimary : this.p.text)
      .padding({ left: 14, right: 14, top: 8, bottom: 8 })
      .borderRadius(14)
      .backgroundColor(this.selected ? this.p.primarySolid : this.p.surface)
      .margin({ right: 8, bottom: 8 })
      .onClick(this.onTap)
  }
}

export default FilterChipComponent;
