// SPDX-License-Identifier: Apache-2.0

import AppKit
import Darwin
import Foundation
import WebKit

struct Configuration: Decodable {
    let url: String
    let library: String?
    let calls: Int
    let interval: Int
    let operationMs: Int
}
struct ProbeError: Error { let message: String }

final class Navigation: NSObject, WKNavigationDelegate {
    var finished = false
    var failure: Error?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failure = error }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failure = error }
}

func measure(_ config: Configuration) throws -> [String: Any] {
    NSApplication.shared.setActivationPolicy(.prohibited)
    let settings = WKWebViewConfiguration()
    settings.websiteDataStore = .nonPersistent()
    let page = WKWebView(frame: .zero, configuration: settings)
    defer { page.stopLoading() }
    let navigation = Navigation()
    page.navigationDelegate = navigation
    page.load(URLRequest(url: URL(string: config.url)!))
    let navigationDeadline = Date().addingTimeInterval(Double(config.operationMs) / 1000)
    while !navigation.finished && navigation.failure == nil {
        if Date() >= navigationDeadline { throw ProbeError(message: "WebKit navigation timed out") }
        RunLoop.current.run(until: Date().addingTimeInterval(0.001))
    }
    if let failure = navigation.failure { throw failure }
    func evaluate(_ code: String) throws -> Any {
        var result: Result<Any, Error>?
        page.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { result = $0 }
        let deadline = Date().addingTimeInterval(Double(config.operationMs) / 1000)
        while result == nil {
            if Date() >= deadline { throw ProbeError(message: "WebKit evaluation timed out: \(code)") }
            RunLoop.current.run(until: Date().addingTimeInterval(0.001))
        }
        return try result!.get()
    }
    // Import completion is the readiness signal; no settling delay or inspector alters this process.
    let moduleURL = URL(string: "entry.js", relativeTo: URL(string: config.url)!)!.absoluteString
    let url = String(data: try JSONSerialization.data(withJSONObject: moduleURL, options: .fragmentsAllowed), encoding: .utf8)!
    _ = try evaluate("globalThis.subject = await import(\(url)); return true")
    guard page.responds(to: NSSelectorFromString("_webProcessIdentifier")),
          let pid = page.value(forKey: "_webProcessIdentifier") as? NSNumber, pid.int32Value > 0 else {
        throw ProbeError(message: "WebKit does not expose the owned renderer PID")
    }
    func rss() throws -> UInt64 {
        var info = proc_taskinfo()
        let size = Int32(MemoryLayout<proc_taskinfo>.size)
        guard proc_pidinfo(pid.int32Value, PROC_PIDTASKINFO, 0, &info, size) == size,
              info.pti_resident_size > 0 else {
            throw ProbeError(message: "Owned WebKit renderer returned no RSS")
        }
        return info.pti_resident_size
    }
    var peak: UInt64 = 0
    if let library = config.library {
        let name = String(data: try JSONSerialization.data(withJSONObject: library, options: .fragmentsAllowed), encoding: .utf8)!
        _ = try evaluate("return subject.select(\(name))")
        var completed = 0
        while completed < config.calls {
            let count = completed == 0 ? 1 : min(config.interval, config.calls - completed)
            _ = try evaluate("return subject.advance(\(count))")
            peak = max(peak, try rss())
            completed += count
        }
        guard let valid = try evaluate("return subject.validate(\(config.calls))") as? Bool, valid else {
            throw ProbeError(message: "Wrong final value or parse count: \(library)")
        }
    } else {
        let baseline = try rss()
        _ = try evaluate("return subject.control()")
        peak = try rss()
        guard peak > baseline else { throw ProbeError(message: "RSS missed the held control") }
    }
    return ["library": config.library ?? "held-control", "peakBytes": peak, "rendererPID": pid,
            "frameworkPath": Bundle(identifier: "com.apple.WebKit")?.bundlePath ?? "unknown"]
}

do {
    let config = try JSONDecoder().decode(Configuration.self, from: FileHandle.standardInput.readDataToEndOfFile())
    let output = try JSONSerialization.data(withJSONObject: measure(config), options: .sortedKeys)
    print(String(data: output, encoding: .utf8)!)
} catch {
    FileHandle.standardError.write(Data("WebKit RSS measurement failed: \(error)\n".utf8))
    exit(1)
}
