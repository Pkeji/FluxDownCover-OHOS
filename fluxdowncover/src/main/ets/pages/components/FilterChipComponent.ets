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
      .fontColor(this.selected ? this.p.text : this.p.textSecondary)
      .padding({ left: 14, right: 14, top: 8, bottom: 8 })
      .borderRadius(14)
      .backgroundColor(this.selected ? this.p.surfaceHighlight : Color.Transparent)
      .border(this.selected ? { width: 1, color: this.p.border } : { width: 0 })
      .margin({ right: 8, bottom: 8 })
      .onClick(this.onTap)
  }
}

export default FilterChipComponent;
