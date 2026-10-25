import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ label: String) throws {
    if !condition() { throw NSError(domain:"NativeDeliveryTests",code:1,userInfo:[NSLocalizedDescriptionKey:label]) }
}
let testRoot=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let store=NativeDeliveryStore(root:testRoot) { text in
    guard let data=text.data(using:.utf8), let value=try JSONSerialization.jsonObject(with:data) as? [String:Any],value["format"] as? String == "local-feishu",value["version"] as? Int == 2 else {throw DeliveryError.invalid}
}
let input=FileHandle.standardInput.readDataToEndOfFile()
let text=String(data:input,encoding:.utf8)!
let hash=NativeDeliveryStore.digest(input)
let id="00000000-0000-4000-8000-000000000001"
if CommandLine.arguments.count>2 {
    let result=try store.save(jobId:id,text:text,sha256:hash)
    print(result.created ? "CREATED":"REUSED")
} else {
    var checks=0
    func check(_ ok: Bool,_ label:String) throws {try expect(ok,label);checks+=1}
    let saved=try store.save(jobId:id,text:text,sha256:hash)
    try check(saved.created,"first write")
    try check(saved.reply["status"] as? String == "SAVED","status")
    try check(saved.reply["sha256"] as? String == hash,"receipt digest")
    let repeated=try store.save(jobId:id.uppercased(),text:text,sha256:hash)
    try check(!repeated.created,"same bytes reuse")
    let found=try store.query(jobId:id)
    try check(found["jobId"] as? String == id,"query id")
    try check(found["partial"] as? Bool == true,"partial metadata")
    try check(try FileManager.default.contentsOfDirectory(atPath:testRoot.appendingPathComponent("Inbox").path).count == 1,"one file")
    let mode=try FileManager.default.attributesOfItem(atPath:saved.url.path)[.posixPermissions] as? Int
    try check(mode == 0o600,"private file")
    let different=text+" "
    do {_ = try store.save(jobId:id,text:different,sha256:NativeDeliveryStore.digest(Data(different.utf8)));throw NSError(domain:"missing conflict",code:1)}catch DeliveryError.conflict {checks+=1}
    try check(try store.bounded(saved.url) == input,"conflict preserves file")
    do {_ = try store.save(jobId:"../escape",text:text,sha256:hash);throw NSError(domain:"missing invalid id",code:1)}catch DeliveryError.invalid {checks+=1}
    do {_ = try store.save(jobId:"00000000-0000-4000-8000-000000000002",text:text,sha256:String(repeating:"0",count:64));throw NSError(domain:"missing invalid hash",code:1)}catch DeliveryError.invalid {checks+=1}
    let receipt=testRoot.appendingPathComponent("TaskReceipts/"+id+".json")
    try FileManager.default.removeItem(at:receipt)
    let repaired=try store.query(jobId:id)
    try check(repaired["status"] as? String == "SAVED","repair receipt after commit")
    try check(FileManager.default.fileExists(atPath:receipt.path),"receipt recreated")
    let missing=try store.query(jobId:"00000000-0000-4000-8000-000000000002")
    try check(missing["status"] as? String == "NOT_FOUND","unknown job")
    try FileManager.default.removeItem(at:saved.url)
    try check(try store.query(jobId:id)["status"] as? String == "NOT_FOUND","orphan receipt not success")
    do {_ = try store.save(jobId:id,text:text,sha256:hash);throw NSError(domain:"missing orphan conflict",code:1)}catch DeliveryError.conflict {checks+=1}
    let malicious=testRoot.appendingPathComponent("malicious",isDirectory:true)
    try FileManager.default.createDirectory(at:malicious,withIntermediateDirectories:true)
    try FileManager.default.createSymbolicLink(at:malicious.appendingPathComponent("Inbox"),withDestinationURL:testRoot.appendingPathComponent("Inbox"))
    let other=NativeDeliveryStore(root:malicious,validate:store.validate)
    do {_ = try other.save(jobId:id,text:text,sha256:hash);throw NSError(domain:"missing symlink rejection",code:1)}catch DeliveryError.io {checks+=1}
    print("PASS \(checks)")
}
