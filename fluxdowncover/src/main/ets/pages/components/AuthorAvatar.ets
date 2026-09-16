@ComponentV2
struct AuthorAvatar {
  @Param url: string = '';
  @Param name: string = '?';
  @Param avatarSize: number = 40;
  @Param bg: string = '#E9EBEF';
  @Param fg: string = '#6B7280';
  @Local failed: boolean = false;

  build() {
    Stack() {
      if (!this.failed && this.url.length > 0) {
        Image(this.url)
          .width(this.avatarSize)
          .height(this.avatarSize)
          .objectFit(ImageFit.Cover)
          .onError(() => {
            this.failed = true;
          })
      } else {
        Text(this.initial())
          .fontSize(this.avatarSize * 0.42)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.fg)
      }
    }
    .width(this.avatarSize)
    .height(this.avatarSize)
    .borderRadius(this.avatarSize / 2)
    .clip(true)
    .backgroundColor(this.bg)
  }

  private initial(): string {
    const n = this.name.trim();
    return n.length > 0 ? n.substring(0, 1).toUpperCase() : '?';
  }
}

export default AuthorAvatar;
