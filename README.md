# 本地文档 · 浏览器助手

macOS 本地文档/电子表格编辑器，配套 Chrome 扩展，将当前打开且获准保存的飞书页面内容保存为 `.localdoc` 可编辑副本和单文件 HTML 阅读版。

**开发候选版：0.4.0。原冻结版 v0.2.8 保留。** 0.4.0 完成了资料库管理和保存任务恢复机制，仍不具备“全部飞书内容、外观和可编辑回导完全一致”的发布验收结果。自动检查通过不能替代真实来源覆盖和回导比较。幻灯片暂不纳入范围。

## 使用

1. 将构建出的 `本地文档-0.4.0.app` 放到固定的应用目录并打开。在“设置与连接”检查版本，点击“修复本机连接”，再点击“显示配套插件”。
2. Chrome 打开 `chrome://extensions`，开启开发者模式，加载配套 `chrome-extension-0.4.0` 文件夹；已有同 ID 插件可更新其加载路径后重新加载。App 和插件请成对使用。
3. 打开获准保存的飞书文档或电子表格，点击插件。默认同时保存可编辑副本和 HTML。弹窗关闭后可重新打开查看原任务；确认写入结果前不会自动另建重复副本。
4. App“保存任务”可打开已落盘的结果、显示 HTML 位置；HTML 输出中断时可按原副本校验并修复。
5. 在 App 内编辑、重命名、搜索标题和分配文件夹。“导出”菜单可保存 `.localdoc`、HTML 或显示 Finder 位置。删除进入“最近删除”，可以恢复；当前没有永久清空功能。

`.localdoc` 保留本地编辑结构与采集信息；HTML 内嵌已取得的图片和样式，适合离线阅读，不能补回未加载或无权读取的内容。HTML 公式显示静态结果，不会重新计算。选择 HTML 也保留恢复用的 `.localdoc`。

飞书回导是默认关闭的实验入口，可在设置中显式开启。当前通过 Office 格式创建新的飞书副本，存在不支持对象与兼容性限制；不应将它当作无损原生恢复。完整性检查未通过的内容会阻止回导。

## M4 MacBook Air / iCloud

App 目标为 Apple Silicon、macOS 13+。iCloud 可以传递应用构建和显式导出的文件，但每台 Mac 仍需分别加载 Chrome 插件、修复该机接收配置。请先让应用包和文件下载完整，再将 App 复制到固定应用目录。

桌面资料库位于当前 Mac 的 `~/Library/Application Support/LocalDocs/`，不会自动跨 Mac 同步。迁移文档请“导出 → 保存可编辑副本”到 iCloud，再在另一台 Mac“打开文件”。打开外部副本会创建独立资料库条目，避免覆盖已有编辑。

## 能力和边界

| 能力 | 当前状态 |
| --- | --- |
| 文档/电子表格本地编辑、文件保存 | 已实现；部分复杂格式仍有适配限制 |
| 标题搜索、文件夹、最近删除恢复 | 0.4.0 已实现 |
| 插件保存任务、去重、停止后续读取、重查 | 0.4.0 已实现 |
| 配对 HTML 写入、哈希确认、中断修复 | 0.4.0 已实现 |
| 普通表格、图片、画板、Base 的适配 | 已有适配；覆盖和外观仍为 PENDING |
| 所有工作表/附件/复杂嵌入自动完整读取 | PENDING；部分对象可能仅有预览或保留结构 |
| 原生可编辑无损回导飞书 | PENDING |
| Developer ID 签名、公证、Chrome 商店发行 | PENDING；当前为本地临时签名开发包 |

出现“保留内容”表示该对象尚未转换为本地可显示/可编辑结构，不代表附件或图形已完整下载。应查看“导出检查”的逐对象结果。

## 构建与验证

需要 Node.js 22+ 和 npm；macOS 构建还需 Swift 编译器及 Apple 命令行开发工具。

```sh
npm ci --prefix app
npm test
npm run check
node scripts/build-app.mjs
npm run check:product
```

输出：`dist/本地文档-0.4.0.app`、`dist/chrome-extension-0.4.0`。构建会替换同版本输出目录。若工作区位于 iCloud/File Provider，建议通过 `--application-output=/absolute/path/本地文档-0.4.0.app` 把 App 输出到普通本地目录；构建脚本会校验签名。

只构建扩展：`node scripts/build-app.mjs --extension-only`。网页版：`npm run dev --prefix app`，只监听 `127.0.0.1:8766`；资料保存在该浏览器中，不能使用桌面接收组件。

GitHub Actions 会在 macOS 上执行自动检查和构建。测试使用合成输入与独立临时目录，不上传真实飞书文件。当前验收见 [0.4.0 说明](docs/RELEASE-v0.4.0.md)，数据处理见 [隐私说明](docs/PRIVACY.md)。

## 项目布局

- `app/src`：React、Tiptap 与 Univer 编辑器、资料库和导出入口。
- `desktop`：WKWebView 外壳、事务资料库、Native Messaging 接收与写入确认。
- `extension-next`：当前 Chrome 保存入口与任务控制器。
- `extension`：共享页面/资源读取器，以及早期只读归档实验。
- `shared`：文件校验、内容转换、保留结构与静态 HTML 渲染。
- `tests`：回归检查及原生文件事务测试。

历史冻结资料：[v0.2.8 说明](docs/RELEASE-v0.2.8.md)、[源码锁定](releases/v0.2.8/source-lock.json)。`scripts/package-app.mjs` 是历史 0.2.0 实验，不用于当前构建。真实文件、截图、日志、私有配置、Agent 阶段目录和二进制不进入源码仓库。
