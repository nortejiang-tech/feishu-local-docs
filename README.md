# 本地文档 · 飞书助手

当前冻结版本：**v0.2.8**。macOS 本地文档/电子表格编辑器，配套 Chrome 扩展，从当前已打开且获准保存的飞书页面取得内容，保存为可编辑的 `.localdoc`，或导出单文件 HTML 离线阅读副本。

这是开发版。**完整源内容覆盖、像素级外观一致和飞书可编辑回导仍为 PENDING**。已有内容缺口会明确提示；未加载的工作表、图片和附件不会因导出 HTML 自动补全。幻灯片延期。

## 使用流程

1. 启动本地文档 App。首次使用，在 App 菜单选择“连接 Chrome 插件”。
2. 在 Chrome 扩展管理页开启开发者模式，加载构建得到的 `dist/chrome-extension-0.2.8`。
3. 在浏览器打开获准保存的飞书文档或电子表格，点击扩展“保存到本地”。
4. 在 App 查看、编辑、自动保存；“保存副本”生成 `.localdoc`，“保存为 HTML”生成可离线阅读的 `.html`。

HTML 内嵌已取得的图片和样式，包含所有已采集工作表、合并单元格、行高列宽和静态值。公式不会重新计算；画板/多维表格仍有布局限制。原文保持不变。当前依然可能需要先访问各工作表以促使页面加载，自动完整读取尚待实现。

## 开发与构建

需要 Node.js 22+。macOS App 构建还需 Swift 编译器及 Apple 命令行开发工具；当前构建目标为 Apple Silicon、macOS 13+。

```sh
npm ci --prefix app
npm test
npm run check
node scripts/build-app.mjs
```

输出为 `dist/本地文档-0.2.8.app` 和 `dist/chrome-extension-0.2.8`。App 使用本地临时签名，未做 Developer ID 签名或公证。构建命令会替换同版本输出目录；请保留需要的历史构建。

仅构建 Chrome 扩展：

```sh
node scripts/build-app.mjs --extension-only
```

运行网页版编辑器预览：`npm run dev --prefix app`，默认只监听 `127.0.0.1:8766`。网页版无法使用原生飞书回导和桌面资料库。

## 代码布局

- `app/src`：React、Tiptap 与 Univer 编辑器、文件 IO、HTML/Office 导出入口。
- `desktop/LocalDocs.swift`：macOS WKWebView 外壳、本地资料库、Native Messaging 与保存窗口。
- `extension-next`：当前一键采集扩展入口。
- `extension`：共享的受限页面读取器及早期只读归档实验。
- `shared`：文件格式、校验、转换、保留结构、静态 HTML 渲染。
- `tests`：合成输入的回归测试。

`package.json` 中的 0.1.0 与 `app/package.json` 中的 0.2.0 是早期内部包标识；产品冻结版本以构建脚本和 Git 标签 **v0.2.8** 为准。`scripts/package-app.mjs` 是历史 0.2.0 打包实验，不用于本版本；当前构建请使用上述 `build-app.mjs`。

## 冻结与验收

- [v0.2.8 功能范围、验收和限制](docs/RELEASE-v0.2.8.md)
- [源码逐文件 SHA-256](releases/v0.2.8/source-lock.json)
- [已构建 macOS App 的文件哈希](releases/v0.2.8/artifact-lock.json)

测试与依赖锁文件纳入版本；真实文档、截图、采集结果、私有日志、node_modules、二进制构建产物和本机连接配置不进入 Git。提交本身不扩展任何飞书访问权限。
