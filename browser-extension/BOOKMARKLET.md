# FluxDown Cover Bookmarklet

## 安装

将以下链接拖拽到浏览器书签栏：

```
javascript:void(window.open('fluxdown://download?url='+encodeURIComponent(location.href)))
```

或者手动添加书签：
1. 在浏览器中按 `Ctrl+D` / `Cmd+D` 添加书签
2. 将书签名称改为 `发送到 FluxDown Cover`
3. 将书签 URL 替换为上面的代码

## 使用

在任意网页点击「发送到 FluxDown Cover」书签，当前页面 URL 将通过 `fluxdown://` 深度链接发送到 HarmonyOS 上的 FluxDown Cover 下载管理器。

## 针对链接的 Bookmarklet

如果想在页面上选中一个链接文本后发送该链接：

```javascript
javascript:void((function(){var s=window.getSelection().toString().trim();if(s)window.open('fluxdown://download?url='+encodeURIComponent(s));else alert('请先选中一个下载链接');})())
```
