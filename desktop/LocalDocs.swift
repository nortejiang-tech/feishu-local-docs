import Cocoa
import WebKit
import UniformTypeIdentifiers
import CryptoKit

let fileLimit = 32 * 1024 * 1024
let appDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("LocalDocs", isDirectory: true)
enum LocalError: String, Error { case invalid = "INVALID_FILE", unavailable = "UNAVAILABLE", io = "FILE_IO_FAILED", cancelled = "CANCELLED" }
func safeEnvelope(_ text: String) throws -> (id: String, title: String) {
    guard let bytes = text.data(using: .utf8), bytes.count <= fileLimit,
          let envelope = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          envelope["format"] as? String == "local-feishu", envelope["version"] as? Int == 2,
          let hash = envelope["sha256"] as? String, hash.count == 64,
          let doc = envelope["document"] as? [String: Any], let id = doc["id"] as? String,
          UUID(uuidString: id) != nil, let title = doc["title"] as? String, title.count <= 1000,
          let kind = doc["kind"] as? String, ["document", "sheet"].contains(kind) else { throw LocalError.invalid }
    return (id, title)
}
func readBounded(_ url: URL) throws -> String {
    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= fileLimit else { throw LocalError.invalid }
    return try String(contentsOf: url, encoding: .utf8)
}
func writePrivate(_ text: String, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try text.write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
func jsonLiteral(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), let text = String(data: data, encoding: .utf8) else { return "null" }
    return text
}

// Serve bundled application code only; document data never becomes an executable resource.
final class AppScheme: NSObject, WKURLSchemeHandler {
    let base: URL
    init(base: URL) { self.base = base.standardizedFileURL.resolvingSymlinksInPath() }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let u = urlSchemeTask.request.url, u.scheme == "localdocs", u.host == "app", urlSchemeTask.request.httpMethod == "GET" else { urlSchemeTask.didFailWithError(LocalError.invalid); return }
        let path = u.path == "/" ? "index.html" : String(u.path.dropFirst())
        let file = base.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(base.path + "/"), let data = try? Data(contentsOf: file), data.count < 50_000_000 else { urlSchemeTask.didFailWithError(LocalError.invalid); return }
        let mime = ["html":"text/html", "js":"text/javascript", "mjs":"text/javascript", "css":"text/css", "json":"application/json", "svg":"image/svg+xml", "png":"image/png", "woff2":"font/woff2"][file.pathExtension] ?? "application/octet-stream"
        let headers = ["Content-Type":mime, "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"]
        urlSchemeTask.didReceive(HTTPURLResponse(url: u, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var pageReady = false
    var pendingFiles: [URL] = []
    var cloudBusy = false
    var closeAllowed = false
    var closeInProgress = false
    var quitRequested = false
    let library = appDirectory.appendingPathComponent("Library", isDirectory: true)
    let fileQueue = DispatchQueue(label: "localdocs.files")
    func applicationDidFinishLaunching(_ notification: Notification) {
        let appMenu = NSMenu(); let root = NSMenuItem(); appMenu.addItem(root)
        let menu = NSMenu(); menu.addItem(withTitle:"关于本地文档", action:#selector(about), keyEquivalent:"")
        menu.addItem(withTitle:"连接 Chrome 插件", action:#selector(connectChrome), keyEquivalent:"")
        menu.addItem(.separator()); menu.addItem(withTitle:"退出本地文档", action:#selector(NSApplication.terminate(_:)), keyEquivalent:"q"); root.submenu = menu
        let editItem = NSMenuItem(); appMenu.addItem(editItem); let editMenu = NSMenu(title:"编辑"); editItem.submenu = editMenu
        for (name, selector, key) in [("撤销", "undo:", "z"),("重做","redo:","Z"),("剪切","cut:","x"),("拷贝","copy:","c"),("粘贴","paste:","v"),("全选","selectAll:","a")] { editMenu.addItem(withTitle:name, action:Selector(selector), keyEquivalent:key) }
        NSApp.mainMenu = appMenu
        let config = WKWebViewConfiguration()
        let resources = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory:true)
        config.setURLSchemeHandler(AppScheme(base:resources), forURLScheme:"localdocs")
        config.userContentController.add(self, name:"localDocs")
        config.userContentController.addUserScript(WKUserScript(source:"""
        (() => {
          if (!crypto.randomUUID) crypto.randomUUID = () => {
            const a = crypto.getRandomValues(new Uint8Array(16)); a[6] = (a[6] & 15) | 64; a[8] = (a[8] & 63) | 128;
            const h = [...a].map(v => v.toString(16).padStart(2,'0')).join('');
            return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
          };
          const pending = new Map();
          window.localDocsNative = {
            request(action, payload = {}) { return new Promise((resolve, reject) => {
              const id = crypto.randomUUID();
              const timer = setTimeout(() => { pending.delete(id); reject(new Error('NATIVE_TIMEOUT')); }, 180000);
              pending.set(id, { resolve, reject, timer });
              window.webkit.messageHandlers.localDocs.postMessage({ id, action, payload });
            }); },
            complete(reply) { const p = pending.get(reply.id); if (!p) return; clearTimeout(p.timer); pending.delete(reply.id); reply.ok ? p.resolve(reply.data) : p.reject(new Error(reply.error || 'NATIVE_ERROR')); }
          };
        })();
        """, injectionTime:.atDocumentStart, forMainFrameOnly:true))
        webView = WKWebView(frame:.zero, configuration:config); webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:1280,height:860), styleMask:[.titled,.closable,.miniaturizable,.resizable], backing:.buffered, defer:false)
        window.title = "本地文档"; window.minSize = NSSize(width:780,height:560); window.contentView = webView; window.delegate = self
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
        webView.load(URLRequest(url:URL(string:"localdocs://app/index.html")!))
    }
    @objc func about() { let a = NSAlert(); a.messageText = "本地文档 " + (Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "开发版"); a.informativeText = "文档与电子表格的本地编辑开发版。飞书完整保真往返仍在验证中。"; a.runModal() }
    @objc func connectChrome() {
        do {
            guard let host = Bundle.main.executableURL, let id = Bundle.main.object(forInfoDictionaryKey:"ChromeExtensionID") as? String,
                  id.range(of:"^[a-p]{32}$",options:.regularExpression) != nil else { throw LocalError.invalid }
            let configDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts",isDirectory:true)
            let launcher = Bundle.main.resourceURL!.appendingPathComponent("native-host")
            let manifest: [String:Any] = ["name":"cn.localdocs.bridge","description":"本地文档","path":launcher.path,"type":"stdio","allowed_origins":["chrome-extension://\(id)/"]]
            _ = host
            try writePrivate(jsonLiteral(manifest), to:configDir.appendingPathComponent("cn.localdocs.bridge.json"))
            let a = NSAlert(); a.messageText = "本地应用已连接"; a.informativeText = "Chrome 中加载配套插件后，点击插件即可保存到本地。移动本应用后请重新连接。"; a.runModal()
        } catch { let a = NSAlert(); a.messageText = "连接未完成"; a.informativeText = "无法写入当前用户的插件连接配置。"; a.runModal() }
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        pendingFiles += filenames.map { URL(fileURLWithPath:$0) }; deliverFiles(); sender.reply(toOpenOrPrint:.success)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if closeAllowed || !pageReady { return .terminateNow }
        quitRequested = true; requestClose(); return .terminateLater
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeAllowed || !pageReady { return true }
        requestClose(); return false
    }
    func requestClose() {
        guard !closeInProgress else { return }; closeInProgress = true
        webView.evaluateJavaScript("Promise.resolve().then(()=>{if(typeof window.localDocsBeforeClose !== 'function')throw new Error('not ready');return window.localDocsBeforeClose()}).then(()=>window.localDocsNative.request('closeReady')).catch(()=>window.localDocsNative.request('closeFailed'))",completionHandler:nil)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy)->Void) {
        guard let url = navigationAction.request.url, url.scheme == "localdocs", url.host == "app" else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func reply(_ id:String, data:Any = NSNull(), error:String? = nil) {
        DispatchQueue.main.async { self.webView.evaluateJavaScript("window.localDocsNative.complete(\(jsonLiteral(["id":id,"ok":error == nil,"data":data,"error":error ?? ""])))", completionHandler:nil) }
    }
    func deliverFiles() {
        guard pageReady else { return }
        let urls = pendingFiles; pendingFiles = []
        for url in urls {
            do { let text = try readBounded(url); webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('localdocs:incoming',{detail:\(jsonLiteral(["text":text,"name":url.lastPathComponent]))}))", completionHandler:nil) }
            catch { webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('localdocs:error',{detail:'文件无法打开'}))", completionHandler:nil) }
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "localdocs", message.frameInfo.request.url?.host == "app",
              let request = message.body as? [String:Any], let id = request["id"] as? String, UUID(uuidString:id) != nil,
              let action = request["action"] as? String, let p = request["payload"] as? [String:Any] else { return }
        switch action {
        case "sha256":
            guard let text=p["text"] as? String, let data=text.data(using:.utf8),data.count <= fileLimit else { reply(id,error:LocalError.invalid.rawValue); return }
            reply(id,data:SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined())
        case "closeReady":
            reply(id,data:true); closeAllowed=true
            if quitRequested { NSApp.reply(toApplicationShouldTerminate:true) } else { window.close() }
        case "closeFailed":
            closeInProgress=false; if quitRequested { NSApp.reply(toApplicationShouldTerminate:false); quitRequested=false }
            reply(id,data:false); let alert=NSAlert(); alert.messageText="修改尚未保存"; alert.informativeText="请完成保存后再关闭。"; alert.beginSheetModal(for:window)
        case "ready": pageReady = true; reply(id,data:true); DispatchQueue.main.asyncAfter(deadline:.now()+0.1) { self.deliverFiles() }
        case "list":
            fileQueue.async { do {
                try FileManager.default.createDirectory(at:self.library,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                let urls = try FileManager.default.contentsOfDirectory(at:self.library,includingPropertiesForKeys:[.fileSizeKey]).filter{$0.pathExtension == "localdoc"}
                guard urls.count <= 1000 else { throw LocalError.invalid }
                var files: [String] = []; var skipped = 0
                for url in urls { if let text = try? readBounded(url) { files.append(text) } else { skipped += 1 } }
                self.reply(id,data:["files":files,"skipped":skipped])
            } catch { self.reply(id,error:LocalError.io.rawValue) } }
        case "save":
            guard let text = p["text"] as? String else { reply(id,error:LocalError.invalid.rawValue); return }
            fileQueue.async { do {
                let meta = try safeEnvelope(text); let url = self.library.appendingPathComponent(meta.id+".localdoc")
                try writePrivate(text,to:url)
                guard try readBounded(url) == text else { throw LocalError.io }
                self.reply(id,data:["savedAt":ISO8601DateFormatter().string(from:Date()),"location":"本机资料库"])
            } catch { self.reply(id,error:LocalError.io.rawValue) } }
        case "open":
            let panel = NSOpenPanel(); panel.allowedContentTypes = [.json, UTType(filenameExtension:"localdoc") ?? .data]; panel.allowsMultipleSelection = false
            panel.beginSheetModal(for:window) { response in
                guard response == .OK, let url = panel.url else { self.reply(id); return }
                do { self.reply(id,data:["text":try readBounded(url),"name":url.lastPathComponent]) } catch { self.reply(id,error:LocalError.io.rawValue) }
            }
        case "saveCopy":
            guard let text = p["text"] as? String, (try? safeEnvelope(text)) != nil else { reply(id,error:LocalError.invalid.rawValue); return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = (p["name"] as? String ?? "文档.localdoc"); panel.allowedContentTypes = [UTType(filenameExtension:"localdoc") ?? .data]
            panel.beginSheetModal(for:window) { response in
                guard response == .OK, let url = panel.url else { self.reply(id,data:["cancelled":true]); return }
                do { try writePrivate(text,to:url); guard try readBounded(url) == text else { throw LocalError.io }; self.reply(id,data:["cancelled":false]) } catch { self.reply(id,error:LocalError.io.rawValue) }
            }
        case "saveHtml":
            // Additive export only. The trusted renderer provides inert standalone HTML;
            // the native bridge never loads/evaluates it or replaces the library document.
            guard let text = p["text"] as? String, text.utf8.count <= fileLimit,
                  text.hasPrefix("<!doctype html>"), text.contains("<meta name=\"generator\" content=\"LocalDocs HTML\">"),
                  let name = p["name"] as? String, name.hasSuffix(".html"), name.count <= 300,
                  !name.contains("/"), !name.contains("\\"), !name.contains("\n") else { reply(id,error:LocalError.invalid.rawValue); return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = name; panel.allowedContentTypes = [.html]
            panel.beginSheetModal(for:window) { response in
                guard response == .OK, let url = panel.url else { self.reply(id,data:["cancelled":true]); return }
                self.fileQueue.async { do {
                    try writePrivate(text,to:url)
                    guard try readBounded(url) == text else { throw LocalError.io }
                    self.reply(id,data:["cancelled":false])
                } catch { self.reply(id,error:LocalError.io.rawValue) } }
            }
        case "importOffice": importOffice(id,payload:p)
        case "openURL":
            guard let value = p["url"] as? String, let u = URL(string:value), u.scheme == "https", let h=u.host, h == "feishu.cn" || h.hasSuffix(".feishu.cn") || h == "larksuite.com" || h.hasSuffix(".larksuite.com"), u.user == nil, u.password == nil else { reply(id,error:LocalError.invalid.rawValue); return }
            NSWorkspace.shared.open(u); reply(id,data:true)
        default: reply(id,error:LocalError.invalid.rawValue)
        }
    }
    func importOffice(_ id:String,payload p:[String:Any]) {
        guard !cloudBusy, let format=p["format"] as? String, ["docx","xlsx"].contains(format), let encoded=p["base64"] as? String,
              encoded.count < 48_000_000, let data=Data(base64Encoded:encoded), data.count <= fileLimit, data.starts(with:[0x50,0x4b]),
              let title=p["title"] as? String, !title.isEmpty, title.count <= 200 else { reply(id,error:"IMPORT_INPUT_INVALID"); return }
        let cli=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".npm-global/bin/lark-cli")
        guard FileManager.default.isExecutableFile(atPath:cli.path) else { reply(id,error:"FEISHU_CONNECTION_UNAVAILABLE"); return }
        cloudBusy=true
        DispatchQueue.global(qos:.userInitiated).async {
            let job=appDirectory.appendingPathComponent("Jobs/"+UUID().uuidString,isDirectory:true)
            defer { DispatchQueue.main.async { self.cloudBusy=false }; try? FileManager.default.removeItem(at:job) }
            do {
                try FileManager.default.createDirectory(at:job,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                let file=job.appendingPathComponent("document."+format); try data.write(to:file,options:.atomic); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
                let process=Process(); process.executableURL=cli; process.currentDirectoryURL=job
                process.arguments=["drive","+import","--file","./document."+format,"--type",format == "docx" ? "docx":"sheet","--name",title,"--as","user","--format","json"]
                process.environment=["HOME":FileManager.default.homeDirectoryForCurrentUser.path,"PATH":"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin","LANG":"zh_CN.UTF-8"]
                let output=Pipe(); process.standardOutput=output; process.standardError=FileHandle.nullDevice
                try process.run()
                let watchdog=DispatchWorkItem { if process.isRunning { process.terminate() } }; DispatchQueue.global().asyncAfter(deadline:.now()+150,execute:watchdog)
                let response=output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit(); watchdog.cancel()
                guard response.count < 1_000_000, process.terminationStatus == 0, let envelope=try JSONSerialization.jsonObject(with:response) as? [String:Any], envelope["ok"] as? Bool == true, let body=envelope["data"] as? [String:Any] else { self.reply(id,error:"FEISHU_IMPORT_FAILED"); return }
                // Only a validated final URL counts as creation. A task ticket is still pending.
                func findURL(_ object:Any,depth:Int=0)->String? {
                    if depth > 6 { return nil }
                    if let dict=object as? [String:Any] {
                        if let value=dict["url"] as? String, let url=URL(string:value),url.scheme == "https",let h=url.host,(h.hasSuffix(".feishu.cn") || h.hasSuffix(".larksuite.com")), url.path.hasPrefix("/docx/") || url.path.hasPrefix("/sheets/") { return value }
                        for key in ["result","import_result","document","spreadsheet","extra"] { if let child=dict[key],let value=findURL(child,depth:depth+1) { return value } }
                    }; return nil
                }
                guard let url=findURL(body),body["ready"] as? Bool != false else { self.reply(id,data:["status":"PENDING","verification":"PENDING","url":""]); return }
                self.reply(id,data:["status":"CREATED","verification":"PENDING","url":url])
            } catch { self.reply(id,error:"FEISHU_IMPORT_FAILED") }
        }
    }
}

func runNativeHost() {
    let input=FileHandle.standardInput, output=FileHandle.standardOutput
    func respond(_ object:[String:Any]) { let data=try! JSONSerialization.data(withJSONObject:object); var length=UInt32(data.count).littleEndian; output.write(Data(bytes:&length,count:4)); output.write(data) }
    do {
        guard let expected=Bundle.main.object(forInfoDictionaryKey:"ChromeExtensionID") as? String,
              CommandLine.arguments.contains("chrome-extension://"+expected+"/") else { throw LocalError.invalid }
        let header=input.readData(ofLength:4); guard header.count==4 else { throw LocalError.invalid }
        let size=header.enumerated().reduce(UInt32(0)) { $0 | (UInt32($1.element) << (8*$1.offset)) }
        guard size > 0,size < 48_000_000 else { throw LocalError.invalid }
        var data=Data(); while data.count<Int(size) { let chunk=input.readData(ofLength:min(1_048_576,Int(size)-data.count)); if chunk.isEmpty { throw LocalError.invalid }; data.append(chunk) }
        guard let message=try JSONSerialization.jsonObject(with:data) as? [String:Any], message["operation"] as? String=="save", let text=message["text"] as? String else { throw LocalError.invalid }
        _ = try safeEnvelope(text)
        let requestId=UUID().uuidString, url=appDirectory.appendingPathComponent("Inbox/"+requestId+".localdoc")
        try writePrivate(text,to:url)
        let launcher=Process(); launcher.executableURL=URL(fileURLWithPath:"/usr/bin/open"); launcher.arguments=["-a",Bundle.main.bundleURL.path,url.path]; launcher.standardOutput=FileHandle.nullDevice; launcher.standardError=FileHandle.nullDevice; try launcher.run(); launcher.waitUntilExit()
        guard launcher.terminationStatus==0 else { throw LocalError.io }
        respond(["ok":true,"requestId":requestId,"status":"DELIVERED","verification":"PENDING"])
    } catch { respond(["ok":false,"code":"LOCAL_DELIVERY_FAILED"]) }
}

if CommandLine.arguments.contains("--native-host") { runNativeHost() }
else { let app=NSApplication.shared; let delegate=AppDelegate(); app.delegate=delegate; app.setActivationPolicy(.regular); app.run() }
