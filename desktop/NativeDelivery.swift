import Foundation
import CryptoKit
import Darwin

// This store only accepts a UUID, never a destination path from a page or extension.
enum DeliveryError: String, Error {
    case invalid = "INVALID_TASK"
    case conflict = "TASK_CONFLICT"
    case io = "LOCAL_DELIVERY_FAILED"
    case incomplete = "OUTPUT_PENDING"
}

final class NativeDeliveryStore {
    let root: URL
    let validate: (String) throws -> Void
    let limit = 32 * 1024 * 1024
    init(root: URL, validate: @escaping (String) throws -> Void) {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        self.validate = validate
    }
    static func digest(_ data: Data) -> String {
        SHA256.hash(data:data).map { String(format:"%02x", $0) }.joined()
    }
    func identifier(_ value: String) throws -> String {
        guard value.count == 36, let id = UUID(uuidString:value) else { throw DeliveryError.invalid }
        return id.uuidString.lowercased()
    }
    func directory(_ name: String) throws -> URL {
        let url = root.appendingPathComponent(name, isDirectory:true)
        try FileManager.default.createDirectory(at:url, withIntermediateDirectories:true, attributes:[.posixPermissions:0o700])
        let values = try url.resourceValues(forKeys:[.isSymbolicLinkKey, .isDirectoryKey])
        guard values.isSymbolicLink != true, values.isDirectory == true else { throw DeliveryError.io }
        return url
    }
    func bounded(_ url: URL) throws -> Data {
        let values = try url.resourceValues(forKeys:[.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              (values.fileSize ?? Int.max) <= limit else { throw DeliveryError.io }
        let data = try Data(contentsOf:url)
        guard data.count <= limit else { throw DeliveryError.io }
        return data
    }
    func locked<T>(_ id: String, _ body: () throws -> T) throws -> T {
        let url = try directory("DeliveryLocks").appendingPathComponent(id+".lock")
        let fd = Darwin.open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw DeliveryError.io }
        defer { Darwin.close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw DeliveryError.io }
        defer { flock(fd, LOCK_UN) }
        return try body()
    }
    func file(_ id: String) throws -> URL { try directory("Inbox").appendingPathComponent(id+".localdoc") }
    func atomic(_ data: Data, _ url: URL) throws {
        if FileManager.default.fileExists(atPath:url.path) { _ = try bounded(url) }
        try data.write(to:url, options:[.atomic])
        try FileManager.default.setAttributes([.posixPermissions:0o600], ofItemAtPath:url.path)
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw DeliveryError.io }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw DeliveryError.io }
        guard try bounded(url) == data else { throw DeliveryError.io }
    }
    func receipt(_ id: String, _ bytes: Data) throws -> [String:Any] {
        guard let text = String(data:bytes, encoding:.utf8) else { throw DeliveryError.invalid }
        try validate(text)
        let hash = Self.digest(bytes)
        let envelope = try JSONSerialization.jsonObject(with:bytes) as? [String:Any]
        let doc = envelope?["document"] as? [String:Any]
        var partial = (doc?["issues"] as? [[String:Any]] ?? []).contains { ($0["count"] as? Int ?? 0) > 0 }
        let planURL=try directory("OutputPlans").appendingPathComponent(id+".json")
        var htmlHash:String?
        if FileManager.default.fileExists(atPath:planURL.path){
            guard let plan=try JSONSerialization.jsonObject(with:bounded(planURL)) as? [String:Any],plan["documentHash"] as? String==hash,let expected=plan["htmlHash"] as? String else{throw DeliveryError.conflict}
            let htmlURL=try directory("Inbox").appendingPathComponent(id+".html")
            guard FileManager.default.fileExists(atPath:htmlURL.path) else{throw DeliveryError.incomplete}
            guard try Self.digest(bounded(htmlURL))==expected else{throw DeliveryError.conflict}
            htmlHash=expected;partial=partial || plan["partial"] as? Bool==true
        }
        let url = try directory("TaskReceipts").appendingPathComponent(id+".json")
        if FileManager.default.fileExists(atPath:url.path) {
            let stored = try JSONSerialization.jsonObject(with:bounded(url)) as? [String:Any]
            guard stored?["jobId"] as? String == id, stored?["sha256"] as? String == hash,
                  stored?["status"] as? String == "SAVED", stored?["protocolVersion"] as? Int == 1 else { throw DeliveryError.conflict }
        }
        var result: [String:Any] = ["ok":true,"protocolVersion":1,"jobId":id,"requestId":id,"status":"SAVED","sha256":hash,"partial":partial,"verification":"PENDING"]
        if let htmlHash=htmlHash{result["htmlSha256"]=htmlHash;result["htmlSaved"]=true}
        // A crash after the file commit but before this receipt is repaired by query.
        let encoded = try JSONSerialization.data(withJSONObject:result, options:[.sortedKeys])
        try atomic(encoded, url)
        return result
    }
    func query(jobId: String) throws -> [String:Any] {
        let id = try identifier(jobId)
        return try locked(id) {
            let url = try file(id)
            guard FileManager.default.fileExists(atPath:url.path) else {
                // An orphan receipt is not proof that a usable file still exists.
                let planURL=try directory("OutputPlans").appendingPathComponent(id+".json"),receiptURL=try directory("TaskReceipts").appendingPathComponent(id+".json")
                let requiresNewJob=FileManager.default.fileExists(atPath:planURL.path)||FileManager.default.fileExists(atPath:receiptURL.path)
                return ["ok":true,"protocolVersion":1,"jobId":id,"status":"NOT_FOUND","requiresNewJob":requiresNewJob]
            }
            return try receipt(id, bounded(url))
        }
    }
    func validatedHTML(_ html:String)throws->Data{
        let data=Data(html.utf8)
        guard data.count<=limit,html.hasPrefix("<!doctype html>"),html.contains("<meta name=\"generator\" content=\"LocalDocs HTML\">"),html.contains("script-src 'none'"),html.contains("connect-src 'none'"),html.range(of:"<(script|iframe|object|embed|base)\\b",options:[.regularExpression,.caseInsensitive])==nil else{throw DeliveryError.invalid}
        return data
    }
    func save(jobId: String, text: String, sha256: String, html:String?=nil, htmlPartial:Bool=false) throws -> (reply: [String:Any], url: URL, created: Bool) {
        let id = try identifier(jobId), bytes = Data(text.utf8)
        guard bytes.count <= limit, sha256 == Self.digest(bytes) else { throw DeliveryError.invalid }
        try validate(text)
        let htmlBytes=try html.map{try validatedHTML($0)}
        return try locked(id) {
            let url = try file(id)
            let existed = FileManager.default.fileExists(atPath:url.path)
            if existed{guard try bounded(url)==bytes else{throw DeliveryError.conflict}}
            else if FileManager.default.fileExists(atPath:try directory("TaskReceipts").appendingPathComponent(id+".json").path){throw DeliveryError.conflict}
            if let htmlBytes=htmlBytes{
                let planURL=try directory("OutputPlans").appendingPathComponent(id+".json")
                let plan:[String:Any]=["documentHash":sha256,"htmlHash":Self.digest(htmlBytes),"partial":htmlPartial]
                if FileManager.default.fileExists(atPath:planURL.path){
                    let old=try JSONSerialization.jsonObject(with:bounded(planURL)) as? [String:Any]
                    guard old?["documentHash"] as? String==sha256,old?["htmlHash"] as? String==plan["htmlHash"] as? String else{throw DeliveryError.conflict}
                }else{try atomic(JSONSerialization.data(withJSONObject:plan,options:[.sortedKeys]),planURL)}
            }
            if !existed {
                // A receipt without its payload is not silently reused for new content.
                let previous = try directory("TaskReceipts").appendingPathComponent(id+".json")
                if FileManager.default.fileExists(atPath:previous.path) { throw DeliveryError.conflict }
                try atomic(bytes, url)
            }
            if let htmlBytes=htmlBytes{try atomic(htmlBytes,try directory("Inbox").appendingPathComponent(id+".html"))}
            return (try receipt(id, bytes), url, !existed)
        }
    }
    func repairHTML(jobId:String,html:String)throws->[String:Any]{
        let id=try identifier(jobId),bytes=try validatedHTML(html)
        return try locked(id){
            let payload=try bounded(file(id)),planURL=try directory("OutputPlans").appendingPathComponent(id+".json")
            guard let plan=try JSONSerialization.jsonObject(with:bounded(planURL)) as? [String:Any],plan["documentHash"] as? String==Self.digest(payload),plan["htmlHash"] as? String==Self.digest(bytes) else{throw DeliveryError.conflict}
            try atomic(bytes,try directory("Inbox").appendingPathComponent(id+".html"));return try receipt(id,payload)
        }
    }
}
