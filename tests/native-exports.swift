import Foundation
func ensure(_ ok:Bool,_ label:String)throws{if !ok{throw NSError(domain:label,code:1)}}
let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),packet=try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:String]
let text=packet["text"]!,html=packet["html"]!,id="00000000-0000-4000-8000-000000000007"
let exports=NativeExports(root:root){value in guard let data=value.data(using:.utf8),let e=try JSONSerialization.jsonObject(with:data) as? [String:Any],e["format"] as? String=="local-feishu" else{throw DeliveryError.invalid}}
let r=try exports.save(requestId:id,text:html,name:"离线副本.html",kind:"html")
try ensure(r["sha256"] as? String==NativeDeliveryStore.digest(Data(html.utf8)),"exact output hash")
let url=try exports.verifiedFile(requestId:id,name:"离线副本.html",kind:"html",sha256:r["sha256"] as! String)
try ensure(try Data(contentsOf:url)==Data(html.utf8),"readback")
try ensure((try FileManager.default.attributesOfItem(atPath:url.path)[.posixPermissions] as? Int)==0o600,"private file")
try ensure((try FileManager.default.attributesOfItem(atPath:url.deletingLastPathComponent().path)[.posixPermissions] as? Int)==0o700,"private folder")
_ = try exports.save(requestId:id,text:html,name:"离线副本.html",kind:"html")
do{_ = try exports.save(requestId:id,text:html+" ",name:"离线副本.html",kind:"html");throw NSError(domain:"overwritten",code:1)}catch DeliveryError.conflict{}
do{_ = try exports.save(requestId:id,text:html,name:"another.html",kind:"html");throw NSError(domain:"different filename accepted",code:1)}catch DeliveryError.conflict{}
for bad in ["../escape.html","/escape.html","a\\b.html","bad\nname.html",".hidden.html",String(repeating:"中",count:90)+".html"]{
 do{_ = try exports.save(requestId:UUID().uuidString,text:html,name:bad,kind:"html");throw NSError(domain:"unsafe name accepted",code:1)}catch DeliveryError.invalid{}
}
do{_ = try exports.save(requestId:"../bad",text:html,name:"copy.html",kind:"html");throw NSError(domain:"unsafe id",code:1)}catch DeliveryError.invalid{}
do{_ = try exports.save(requestId:UUID().uuidString,text:html+"<script>x()</script>",name:"copy.html",kind:"html");throw NSError(domain:"active content",code:1)}catch DeliveryError.invalid{}
let second="00000000-0000-4000-8000-000000000008"
_ = try exports.save(requestId:second,text:text,name:"可编辑.localdoc",kind:"localdoc")
try ensure(try Data(contentsOf:exports.file(second,name:"可编辑.localdoc",kind:"localdoc"))==Data(text.utf8),"portable bytes")
do{_ = try exports.verifiedFile(requestId:id,name:"离线副本.html",kind:"html",sha256:String(repeating:"0",count:64));throw NSError(domain:"bad reveal hash",code:1)}catch DeliveryError.conflict{}
try ensure(try Data(contentsOf:url)==Data(html.utf8),"conflicts preserve original output")
let badRoot=root.appendingPathComponent("link-test"),outside=root.appendingPathComponent("outside")
try FileManager.default.createDirectory(at:badRoot,withIntermediateDirectories:true)
try FileManager.default.createDirectory(at:outside,withIntermediateDirectories:true)
try FileManager.default.createSymbolicLink(at:badRoot.appendingPathComponent("Exports"),withDestinationURL:outside)
do{_ = try NativeExports(root:badRoot,validate:{_ in}).save(requestId:id,text:html,name:"copy.html",kind:"html");throw NSError(domain:"symlink accepted",code:1)}catch DeliveryError.io{}
try ensure(try FileManager.default.contentsOfDirectory(atPath:outside.path).isEmpty,"outside path untouched")
print("PASS native exports: exact bytes, idempotent retry, conflict isolation, path bounds, permissions, symlink rejection")
