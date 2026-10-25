import Foundation
func ensure(_ value:Bool,_ message:String)throws{if !value{throw NSError(domain:message,code:1)}}
let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let store=NativeLibrary(root:root){text in guard let data=text.data(using:.utf8),let env=try JSONSerialization.jsonObject(with:data) as? [String:Any],env["format"] as? String=="local-feishu",env["version"] as? Int==2 else{throw LibraryFailure.invalid}}
let input=try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:String]
let first=input["first"]!,updated=input["updated"]!,conflict=input["conflict"]!,id=input["id"]!
try store.save(first);try store.save(first)
let index=try store.list(),rows=index["files"] as! [[String:Any]]
try ensure(rows.count==1,"one row");try ensure(rows[0]["content"]==nil&&rows[0]["provenance"]==nil,"metadata only");try ensure(rows[0]["folder"] as? String=="工程","folder");try ensure(try store.load(id)==first,"load")
do{try store.save(conflict);throw NSError(domain:"missing conflict",code:1)}catch LibraryFailure.conflict{}
try ensure(try store.load(id)==first,"same revision preserved")
let firstHash=(try JSONSerialization.jsonObject(with:Data(first.utf8)) as! [String:Any])["sha256"] as! String
try store.save(updated,expectedHash:firstHash);try ensure(try store.load(id)==updated,"new revision persisted")
do{try store.save(first);throw NSError(domain:"missing stale conflict",code:1)}catch LibraryFailure.conflict{}
let updatedHash=(try JSONSerialization.jsonObject(with:Data(updated.utf8)) as! [String:Any])["sha256"] as! String
let stale=input["stale"]!
do{try store.save(stale,expectedHash:firstHash);throw NSError(domain:"higher revision must not bypass base hash",code:1)}catch LibraryFailure.conflict{}
try ensure(try store.load(id)==updated,"concurrent edit preserved")
let history=try store.listHistory(id)
try ensure(history.count==1,"previous version retained once")
try ensure(history[0]["hash"] as? String==firstHash,"history hash")
try ensure(try store.loadHistory(id,hash:firstHash)==first,"history exact bytes")
do{_ = try store.loadHistory(id,hash:"../escape");throw NSError(domain:"history path accepted",code:1)}catch LibraryFailure.invalid{}
try store.save(updated,expectedHash:updatedHash)
try store.move(id,toTrash:true)
let deleted=(try store.list())["files"] as! [[String:Any]];try ensure(deleted[0]["trashed"] as? Bool==true,"reversible deletion")
do{try store.save(updated);throw NSError(domain:"stale save resurrected",code:1)}catch LibraryFailure.conflict{}
try store.move(id,toTrash:false);try ensure(try store.load(id)==updated,"restore exact bytes")
try ensure(try store.loadHistory(id,hash:firstHash)==first,"history survives trash and restore")
let failedRoot=root.appendingPathComponent("history-unavailable",isDirectory:true)
let failedStore=NativeLibrary(root:failedRoot,validate:store.validate)
try failedStore.save(first)
try FileManager.default.moveItem(at:failedRoot.appendingPathComponent("History"),to:failedRoot.appendingPathComponent("History-retained"))
try "not a directory".write(to:URL(fileURLWithPath:failedRoot.path+"/History"),atomically:true,encoding:.utf8)
do{try failedStore.save(updated,expectedHash:firstHash);throw NSError(domain:"history write failure ignored",code:1)}catch let error as NSError{try ensure(error.domain != "history write failure ignored","history failure propagated")}
try ensure(try failedStore.load(id)==first,"failure before replacement preserves original")
let versions=try JSONSerialization.jsonObject(with:Data(input["versions"]!.utf8)) as! [String]
var baseHash=updatedHash
for text in versions {try store.save(text,expectedHash:baseHash);baseHash=(try JSONSerialization.jsonObject(with:Data(text.utf8)) as! [String:Any])["sha256"] as! String}
let retained=try store.listHistory(id)
try ensure(retained.count==10,"history count bounded")
try ensure(retained.first?["revision"] as? Int==15,"latest retained first")
try ensure(retained.last?["revision"] as? Int==6,"old versions pruned")
do{_ = try store.load("../escape");throw NSError(domain:"path accepted",code:1)}catch LibraryFailure.invalid{}
try "{broken".write(to:try store.directory(false).appendingPathComponent("broken.localdoc"),atomically:true,encoding:.utf8)
try ensure((try store.list())["skipped"] as? Int==1,"corruption preserved and counted")
try ensure(FileManager.default.fileExists(atPath:try store.directory(false).appendingPathComponent("broken.localdoc").path),"corrupt file retained")
print("PASS metadata, read, save, stale/conflict, trash/restore, path and corruption")
