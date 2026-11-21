import Foundation
import Capacitor
import Network
import Security

/**
 * iOS counterpart of the Android CyberNative plugin, reduced to what iOS needs:
 * - a local HTTP proxy on 127.0.0.1 (/proxy and /img) so the web app and its workers can read
 *   provider APIs, playlists, guides and images that don't send CORS headers;
 * - secrets (Xtream passwords, TMDB / OpenSubtitles keys) in the Keychain.
 * Playback uses iOS's own player through <video> (native HLS), no native player plugin here.
 */
@objc(CyberNativePlugin)
public class CyberNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CyberNativePlugin"
    public let jsName = "CyberNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearImageCache", returnType: CAPPluginReturnPromise),
    ]

    private let proxy = LocalProxy()

    public override func load() {
        proxy.start()
    }

    @objc func getInfo(_ call: CAPPluginCall) {
        // the listener binds asynchronously: wait a moment for its port
        var tries = 0
        func answer() {
            if proxy.port == 0 && tries < 40 {
                tries += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: answer)
                return
            }
            call.resolve(["proxyPort": Int(proxy.port), "isTv": false, "sdk": 0, "platform": "ios"])
        }
        answer()
    }

    // ───────────── Keychain ─────────────
    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.cybertv.player", kSecAttrAccount as String: key]
    }

    @objc func secureGet(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data {
            call.resolve(["value": String(data: data, encoding: .utf8) ?? ""])
        } else {
            call.resolve(["value": NSNull()])
        }
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        let value = call.getString("value") ?? ""
        SecItemDelete(query(key) as CFDictionary)
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        status == errSecSuccess ? call.resolve() : call.reject("keychain error \(status)")
    }

    @objc func secureRemove(_ call: CAPPluginCall) {
        SecItemDelete(query(call.getString("key") ?? "") as CFDictionary)
        call.resolve()
    }

    @objc func clearImageCache(_ call: CAPPluginCall) {
        URLCache.shared.removeAllCachedResponses()
        call.resolve()
    }
}

/// Minimal HTTP/1.1 proxy: GET|HEAD /proxy?u=<url> and /img?u=<url>, CORS headers on every answer.
final class LocalProxy {
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    private let queue = DispatchQueue(label: "cyber.proxy", attributes: .concurrent)
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 60
        // images and API answers: a sizeable disk cache (logos and posters come back instantly)
        c.urlCache = URLCache(memoryCapacity: 32 << 20, diskCapacity: 300 << 20)
        c.requestCachePolicy = .useProtocolCachePolicy
        return URLSession(configuration: c)
    }()

    func start() {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        guard let l = try? NWListener(using: params) else { return }
        listener = l
        l.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let p = l.port?.rawValue { self?.port = p }
        }
        l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        l.start(queue: queue)
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let head = String(data: data, encoding: .utf8) else { return conn.cancel() }
            let lines = head.components(separatedBy: "\r\n")
            let parts = lines.first?.split(separator: " ") ?? []
            guard parts.count >= 2 else { return conn.cancel() }
            let method = String(parts[0])
            let target = String(parts[1])
            var headers: [String: String] = [:]
            for l in lines.dropFirst() {
                guard let i = l.firstIndex(of: ":") else { continue }
                headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
            }
            if method == "OPTIONS" { return self.respond(conn, 204, [:], Data()) }
            guard let comps = URLComponents(string: "http://x" + target),
                  let u = comps.queryItems?.first(where: { $0.name == "u" })?.value,
                  let url = URL(string: u), url.scheme == "http" || url.scheme == "https" else {
                return self.respond(conn, 400, ["Content-Type": "text/plain"], Data("missing u".utf8))
            }
            var req = URLRequest(url: url)
            req.httpMethod = method == "HEAD" ? "HEAD" : "GET"
            let wiki = url.host?.hasSuffix("wikimedia.org") == true
            req.setValue(wiki ? "CyberIPTV/1.0 (https://github.com/pickywawa/cybertv)" : (comps.queryItems?.first(where: { $0.name == "ua" })?.value ?? "VLC/3.0.20 LibVLC/3.0.20"), forHTTPHeaderField: "User-Agent")
            if let r = headers["range"] { req.setValue(r, forHTTPHeaderField: "Range") }
            if comps.path == "/img" { req.cachePolicy = .returnCacheDataElseLoad }
            self.session.dataTask(with: req) { body, resp, err in
                guard let http = resp as? HTTPURLResponse else {
                    return self.respond(conn, 502, ["Content-Type": "text/plain"], Data((err?.localizedDescription ?? "error").utf8))
                }
                var h: [String: String] = [:]
                for k in ["Content-Type", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"] {
                    if let v = http.value(forHTTPHeaderField: k) { h[k] = v }
                }
                if comps.path == "/img" { h["Cache-Control"] = "public, max-age=31536000, immutable" }
                self.respond(conn, http.statusCode, h, body ?? Data())
            }.resume()
        }
    }

    private func respond(_ conn: NWConnection, _ code: Int, _ headers: [String: String], _ body: Data) {
        var head = "HTTP/1.1 \(code) \(code < 400 ? "OK" : "Error")\r\n"
        head += "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Expose-Headers: *\r\nConnection: close\r\n"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "Content-Length: \(body.count)\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}

/// Bridge view controller registering the app's own plugin
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(CyberNativePlugin())
    }
}
