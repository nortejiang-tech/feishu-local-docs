import Foundation
func ensure(_ ok:Bool,_ label:String)throws{if !ok{throw NSError(domain:label,code:1)}}
let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),packet=try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:String]
let text=packet["text"]!,html=packet["html"]!,hash=NativeDeliveryStore.digest(Data(text.utf8)),id="00000000-0000-4000-8000-000000000003"
let store=NativeDeliveryStore(root:root){text in guard let data=text.data(using:.utf8),let env=try JSONSerialization.jsonObject(with:data) as? [String:Any],env["format"] as? String=="local-feishu" else{throw DeliveryError.invalid}}
let saved=try store.save(jobId:id,text:text,sha256:hash,html:html,htmlPartial:true)
try ensure(saved.reply["htmlSaved"] as? Bool==true,"HTML confirmed");try ensure(saved.reply["partial"] as? Bool==true,"HTML warnings retained")
try ensure(try store.query(jobId:id)["htmlSha256"] as? String==NativeDeliveryStore.digest(Data(html.utf8)),"HTML hash query")
let htmlURL=root.appendingPathComponent("Inbox/"+id+".html"),receipt=root.appendingPathComponent("TaskReceipts/"+id+".json")
try FileManager.default.removeItem(at:htmlURL);try FileManager.default.removeItem(at:receipt)
do{_ = try store.query(jobId:id);throw NSError(domain:"missing incomplete",code:1)}catch DeliveryError.incomplete{}
try ensure(try store.bounded(saved.url)==Data(text.utf8),"recovery document retained")
do{_ = try store.repairHTML(jobId:id,html:html+" ");throw NSError(domain:"bad repair accepted",code:1)}catch DeliveryError.conflict{}
let repaired=try store.repairHTML(jobId:id,html:html);try ensure(repaired["status"] as? String=="SAVED","repair confirms outputs")
let intentBefore=try store.bounded(root.appendingPathComponent("OutputPlans/"+id+".json"))
do{_ = try store.save(jobId:id,text:text+" ",sha256:NativeDeliveryStore.digest(Data((text+" ").utf8)),html:html);throw NSError(domain:"conflict accepted",code:1)}catch DeliveryError.conflict{}
try ensure(try store.bounded(root.appendingPathComponent("OutputPlans/"+id+".json"))==intentBefore,"conflict cannot change original plan")
do{_ = try store.save(jobId:"00000000-0000-4000-8000-000000000004",text:text,sha256:hash,html:html+"<script>bad()</script>");throw NSError(domain:"script accepted",code:1)}catch DeliveryError.invalid{}
try FileManager.default.removeItem(at:saved.url)
try ensure(try store.query(jobId:id)["requiresNewJob"] as? Bool==true,"orphan plan requires fresh retry identity")
print("PASS paired outputs, hashes, partial commit, repair, conflict isolation, inert HTML")
