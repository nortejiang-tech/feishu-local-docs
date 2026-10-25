import Foundation
import Darwin

enum LibraryFailure: String, Error { case invalid="INVALID_FILE", conflict="FILE_CONFLICT", missing="FILE_NOT_FOUND", io="FILE_IO_FAILED" }
final class NativeLibrary {
    let root: URL
    let validate: (String) throws -> Void
    let limit=32*1024*1024
    init(root:URL,validate:@escaping(String)throws->Void){self.root=root.standardizedFileURL.resolvingSymlinksInPath();self.validate=validate}
    func identifier(_ value:String)throws->String{guard value.count==36,let id=UUID(uuidString:value) else{throw LibraryFailure.invalid};return id.uuidString}
    func directory(_ trash:Bool)throws->URL{
        let url=root.appendingPathComponent(trash ? "RecentlyDeleted":"Library",isDirectory:true)
        try FileManager.default.createDirectory(at:url,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let attrs=try url.resourceValues(forKeys:[.isDirectoryKey,.isSymbolicLinkKey]);guard attrs.isDirectory==true,attrs.isSymbolicLink != true else{throw LibraryFailure.io};return url
    }
    func locked<T>(_ body:()throws->T)throws->T{
        _ = try directory(false)
        let fd=Darwin.open(root.appendingPathComponent(".library.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,S_IRUSR|S_IWUSR)
        guard fd>=0 else{throw LibraryFailure.io};defer{Darwin.close(fd)}
        guard flock(fd,LOCK_EX)==0 else{throw LibraryFailure.io};defer{flock(fd,LOCK_UN)};return try body()
    }
    func url(_ id:String,trash:Bool=false)throws->URL{
        // Preserve the original UUID spelling for old v2 filenames.
        _ = try identifier(id);return try directory(trash).appendingPathComponent(id+".localdoc")
    }
    func read(_ url:URL)throws->String{
        let attrs=try url.resourceValues(forKeys:[.fileSizeKey,.isRegularFileKey,.isSymbolicLinkKey])
        guard attrs.isRegularFile==true,attrs.isSymbolicLink != true,(attrs.fileSize ?? Int.max)<=limit else{throw LibraryFailure.invalid}
        let data=try Data(contentsOf:url);guard data.count<=limit,let text=String(data:data,encoding:.utf8) else{throw LibraryFailure.invalid};try validate(text);return text
    }
    func record(_ text:String,trash:Bool=false)throws->[String:Any]{
        guard let bytes=text.data(using:.utf8),let envelope=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],let doc=envelope["document"] as? [String:Any],let id=doc["id"] as? String,
              let title=doc["title"] as? String,let kind=doc["kind"] as? String,["document","sheet"].contains(kind),let revision=doc["revision"] as? Int,revision>=0,
              let createdAt=doc["createdAt"] as? String,let updatedAt=doc["updatedAt"] as? String else{throw LibraryFailure.invalid}
        _ = try identifier(id)
        let local=doc["localMeta"] as? [String:Any] ?? [:]
        let rawFolder=local["folder"] as? String ?? "",folder=rawFolder.trimmingCharacters(in:.whitespacesAndNewlines)
        let task=local["taskId"] as? String
        return ["id":id,"title":title,"kind":kind,"revision":revision,"createdAt":createdAt,"updatedAt":updatedAt,"summary":true,"folder":folder.count<=64 ? folder:"","taskId":task.flatMap{UUID(uuidString:$0) != nil ? $0:nil} as Any? ?? NSNull(),"trashed":trash]
    }
    func list()throws->[String:Any]{try locked{
        var records=[[String:Any]](),skipped=0
        for trash in [false,true]{
            let dir=try directory(trash),files=try FileManager.default.contentsOfDirectory(at:dir,includingPropertiesForKeys:nil).filter{$0.pathExtension=="localdoc"}
            guard files.count<=1000 else{throw LibraryFailure.invalid}
            for file in files {
                do {let value=try autoreleasepool{try record(read(file),trash:trash)}
                    guard value["id"] as? String==file.deletingPathExtension().lastPathComponent else{throw LibraryFailure.invalid};records.append(value)
                }catch{skipped+=1}
            }
        }
        return ["files":records,"skipped":skipped]
    }}
    func load(_ id:String)throws->String{try locked{try read(url(id))}}
    func historyDirectory(_ id:String)throws->URL{
        _ = try identifier(id)
        let parent=root.appendingPathComponent("History",isDirectory:true)
        for dir in [parent,parent.appendingPathComponent(id,isDirectory:true)] {
            try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let attrs=try dir.resourceValues(forKeys:[.isDirectoryKey,.isSymbolicLinkKey])
            guard attrs.isDirectory==true,attrs.isSymbolicLink != true else{throw LibraryFailure.io}
        }
        return parent.appendingPathComponent(id,isDirectory:true)
    }
    func historyURL(_ id:String,_ hash:String)throws->URL{
        guard hash.count==64,hash.allSatisfy({"0123456789abcdef".contains($0)}) else{throw LibraryFailure.invalid}
        return try historyDirectory(id).appendingPathComponent(hash+".localdoc")
    }
    func historyEntries(_ id:String)throws->[[String:Any]]{
        let files=try FileManager.default.contentsOfDirectory(at:historyDirectory(id),includingPropertiesForKeys:[.contentModificationDateKey,.fileSizeKey]).filter{$0.pathExtension=="localdoc"}
        guard files.count<=1000 else{throw LibraryFailure.io}
        return files.compactMap{file in
            do {
                let hash=file.deletingPathExtension().lastPathComponent
                _ = try historyURL(id,hash)
                let text=try read(file),meta=try record(text)
                let envelope=try JSONSerialization.jsonObject(with:Data(text.utf8)) as? [String:Any]
                guard meta["id"] as? String==id,envelope?["sha256"] as? String==hash else{return nil}
                let attrs=try file.resourceValues(forKeys:[.contentModificationDateKey,.fileSizeKey])
                return ["hash":hash,"revision":meta["revision"]!,"title":meta["title"]!,"updatedAt":meta["updatedAt"]!,"savedAt":ISO8601DateFormatter().string(from:attrs.contentModificationDate ?? .distantPast),"bytes":attrs.fileSize ?? 0]
            }catch{return nil}
        }.sorted{($0["revision"] as? Int ?? 0) > ($1["revision"] as? Int ?? 0)}
    }
    func listHistory(_ id:String)throws->[[String:Any]]{try locked{try historyEntries(id)}}
    func loadHistory(_ id:String,hash:String)throws->String{try locked{
        let text=try read(historyURL(id,hash)),meta=try record(text)
        let envelope=try JSONSerialization.jsonObject(with:Data(text.utf8)) as? [String:Any]
        guard meta["id"] as? String==id,envelope?["sha256"] as? String==hash else{throw LibraryFailure.invalid};return text
    }}
    func retainHistory(_ text:String,id:String)throws{
        let envelope=try JSONSerialization.jsonObject(with:Data(text.utf8)) as? [String:Any]
        guard let hash=envelope?["sha256"] as? String else{throw LibraryFailure.invalid}
        let file=try historyURL(id,hash)
        if FileManager.default.fileExists(atPath:file.path){guard try read(file)==text else{throw LibraryFailure.invalid};return}
        try text.write(to:file,atomically:true,encoding:.utf8)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        guard try read(file)==text else{throw LibraryFailure.io}
    }
    func pruneHistory(_ id:String)throws{
        var bytes=0
        for (index,entry) in try historyEntries(id).enumerated(){
            bytes += entry["bytes"] as? Int ?? 0
            if index>=10 || (index>0 && bytes>64*1024*1024){try FileManager.default.removeItem(at:historyURL(id,entry["hash"] as! String))}
        }
    }
    func save(_ text:String,expectedHash:String?=nil)throws{
        try validate(text);let incoming=try record(text);guard let id=incoming["id"] as? String,let revision=incoming["revision"] as? Int else{throw LibraryFailure.invalid}
        try locked {
            let destination=try url(id)
            if FileManager.default.fileExists(atPath:try url(id,trash:true).path){throw LibraryFailure.conflict}
            if FileManager.default.fileExists(atPath:destination.path){
                let previous=try read(destination);if previous==text{return}
                let envelope=try JSONSerialization.jsonObject(with:Data(previous.utf8)) as? [String:Any]
                let meta=try record(previous)
                guard let expectedHash=expectedHash,expectedHash.count==64,envelope?["sha256"] as? String==expectedHash,
                      let oldRevision=meta["revision"] as? Int,oldRevision<revision else{throw LibraryFailure.conflict}
                // Preserve the verified old bytes before attempting replacement. A full disk
                // must fail here without changing the current document.
                try retainHistory(previous,id:id)
            }
            try text.write(to:destination,atomically:true,encoding:.utf8)
            try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:destination.path)
            guard try read(destination)==text else{throw LibraryFailure.io}
            // Retention cleanup is best effort after the confirmed commit.
            try? pruneHistory(id)
        }
    }
    func move(_ id:String,toTrash:Bool)throws{
        try locked{
            let source=try url(id,trash:!toTrash),destination=try url(id,trash:toTrash)
            _ = try read(source)
            guard !FileManager.default.fileExists(atPath:destination.path) else{throw LibraryFailure.conflict}
            try FileManager.default.moveItem(at:source,to:destination)
            _ = try read(destination)
        }
    }
}
