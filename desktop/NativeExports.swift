import Foundation

// Exports are additive copies in an app-owned directory. A request never supplies a path.
final class NativeExports {
    let store: NativeDeliveryStore
    init(root:URL, validate:@escaping (String)throws->Void) { store=NativeDeliveryStore(root:root,validate:validate) }
    func name(_ value:String, kind:String)throws->String {
        guard ["html","localdoc"].contains(kind),!value.isEmpty,value.utf8.count<=240,
              value.hasSuffix("."+kind),!value.hasPrefix("."),
              !value.contains("/"),!value.contains("\\"),
              !value.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)}) else{throw DeliveryError.invalid}
        return value
    }
    func folder()throws->URL { try store.directory("Exports") }
    func file(_ requestId:String, name raw:String, kind:String)throws->URL {
        let id=try store.identifier(requestId),filename=try name(raw,kind:kind)
        _ = try folder()
        return try store.directory("Exports/"+id).appendingPathComponent(filename)
    }
    func save(requestId:String,text:String,name raw:String,kind:String)throws->[String:Any] {
        let id=try store.identifier(requestId),filename=try name(raw,kind:kind)
        let bytes:Data
        if kind=="html" {bytes=try store.validatedHTML(text)}
        else {try store.validate(text);bytes=Data(text.utf8);guard bytes.count<=store.limit else{throw DeliveryError.invalid}}
        return try store.locked(id) {
            let url=try file(id,name:filename,kind:kind)
            let existing=try FileManager.default.contentsOfDirectory(at:url.deletingLastPathComponent(),includingPropertiesForKeys:nil)
            guard existing.allSatisfy({$0.lastPathComponent==filename}) else{throw DeliveryError.conflict}
            if FileManager.default.fileExists(atPath:url.path) {
                guard try store.bounded(url)==bytes else{throw DeliveryError.conflict}
            } else {try store.atomic(bytes,url)}
            guard try store.bounded(url)==bytes else{throw DeliveryError.io}
            return ["cancelled":false,"exportId":id,"name":filename,"kind":kind,"sha256":NativeDeliveryStore.digest(bytes),"location":"本机导出文件夹"]
        }
    }
    func verifiedFile(requestId:String,name:String,kind:String,sha256:String)throws->URL {
        let url=try file(requestId,name:name,kind:kind)
        guard try NativeDeliveryStore.digest(store.bounded(url))==sha256 else{throw DeliveryError.conflict}
        return url
    }
}
