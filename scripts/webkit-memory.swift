// SPDX-License-Identifier: Apache-2.0

import AppKit
import Foundation
import WebKit

// Own an ephemeral page and its hidden inspector; never attach to the user's browser.
struct Cohort: Decodable { let name: String; let width: Int; let retain: Bool }
struct Owner: Decodable { let name: String; let initializer: String }
struct Configuration: Decodable {
    let url: URL
    let operationMs: Int
    let cohorts: [Cohort]
    let owners: [Owner]
    let traceInputs: Bool
}
struct Reading: Encodable { let name: String; let suspended: Int; let ended: Int; let reachability: String? }
struct Group: Encodable { let owner: String; let rows: [Reading] }
struct Output: Encodable { let groups: [Group] }
struct ProbeError: Error, CustomStringConvertible { let description: String }

// WK callbacks require the main run loop, including while waiting for the inspector to load.
func wait(_ milliseconds: Int, _ operation: String, _ ready: () throws -> Bool) throws {
    let end = Date().addingTimeInterval(Double(milliseconds) / 1000)
    while try !ready() {
        if Date() >= end { throw ProbeError(description: "WebKit timed out waiting for \(operation)") }
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
}

enum PageValue { case flag(Bool), text(String) }
func evaluate(_ view: WKWebView, _ code: String, _ milliseconds: Int, operation: String? = nil) throws -> PageValue {
    var reply: Result<Any, Error>?
    // The inspector's CSP rejects eval; inject the owned expression through WebKit itself.
    view.callAsyncJavaScript("return await (" + code + ");", arguments: [:], in: nil, in: .page) {
        reply = $0
    }
    try wait(milliseconds, operation ?? code) { reply != nil }
    guard let reply else { throw ProbeError(description: "WebKit lost its evaluation reply") }
    let value: Any
    do { value = try reply.get() }
    catch {
        // A page, readiness check and heap query cross the same bridge; name the failed one.
        throw ProbeError(description: "WebKit evaluation failed for \(code): \(error)")
    }
    if let text = value as? String { return .text(text) }
    if let flag = value as? Bool { return .flag(flag) }
    throw ProbeError(description: "WebKit evaluation returned neither text nor a Boolean: \(code)")
}

func requireTrue(_ view: WKWebView, _ code: String, _ milliseconds: Int) throws {
    guard case .flag(true) = try evaluate(view, code, milliseconds) else {
        throw ProbeError(description: "WebKit probe rejected operation: \(code)")
    }
}

func measure(_ config: Configuration) throws -> Output {
    NSApplication.shared.setActivationPolicy(.prohibited)
    let settings = WKWebViewConfiguration()
    settings.websiteDataStore = .nonPersistent()
    settings.preferences.setValue(true, forKey: "developerExtrasEnabled")
    let page = WKWebView(frame: .zero, configuration: settings)
    page.isInspectable = true
    defer { page.stopLoading() }
    page.load(URLRequest(url: config.url))
    try wait(config.operationMs, "page readiness at \(config.url)") {
        if case .flag(true) = try evaluate(page, "globalThis.__memoryReady === true", config.operationMs) { return true }
        return false
    }
    guard let inspector = page.value(forKey: "_inspector") as? NSObject else {
        throw ProbeError(description: "WebKit has no inspector; string ownership is unproved")
    }
    defer { inspector.perform(NSSelectorFromString("close")) }
    inspector.perform(NSSelectorFromString("connect"))
    var candidate: WKWebView?
    try wait(config.operationMs, "inspector frontend") {
        candidate = inspector.value(forKey: "inspectorWebView") as? WKWebView
        return candidate != nil
    }
    guard let frontend = candidate else { throw ProbeError(description: "WebKit inspector has no frontend") }
    try wait(config.operationMs, "inspector heap agent") {
        if case .flag(true) = try evaluate(frontend, "typeof WI !== 'undefined' && !!WI.pageTarget?.HeapAgent", config.operationMs) { return true }
        return false
    }
    // The frontend already enables Heap. Leaving its Debugger active stalls the large control.
    try requireTrue(frontend, "(async () => { await WI.pageTarget.DebuggerAgent.disable(); return true; })()", config.operationMs)

    func heap(_ phase: String) throws -> Int {
        // Node sizes detect flat strings, including markers in caller-owned arrays.
        // They do not bound numeric-array backing storage.
        let code = """
        (async () => {
          await WI.pageTarget.HeapAgent.gc();
          const reply = await WI.pageTarget.HeapAgent.snapshot();
          const data = JSON.parse(reply.snapshotData);
          if (data.version !== 3 || !Array.isArray(data.nodes) || data.nodes.length === 0 || data.nodes.length % 4 !== 0)
            throw Error('Unsupported WebKit heap snapshot; ownership is unproved');
          let bytes = 0;
          for (let i = 1; i < data.nodes.length; i += 4) {
            const size = data.nodes[i];
            if (!Number.isSafeInteger(size) || size < 0) throw Error('Invalid WebKit heap node size');
            bytes += size;
          }
          if (!Number.isSafeInteger(bytes)) throw Error('Invalid WebKit heap total');
          return String(bytes);
        })()
        """
        guard case .text(let raw) = try evaluate(frontend, code, config.operationMs, operation: "\(phase) heap collection"),
              let bytes = Int(raw), bytes > 0 else {
            throw ProbeError(description: "WebKit heap counter returned no usable size")
        }
        return bytes
    }

    func sample(_ cohort: Cohort, trackInput: Bool) throws -> Reading {
        _ = try heap("before cohort")
        do {
            try requireTrue(page, "__start(\(cohort.width),\(cohort.retain))", config.operationMs)
            let suspended = try heap("suspended")
            try requireTrue(page, "__advance()", config.operationMs)
            let ended = try heap("ended")
            var reachability: String?
            if trackInput {
                guard case .text(let value) = try evaluate(page, "__inputReachability()", config.operationMs) else {
                    throw ProbeError(description: "WebKit input reachability returned no readings")
                }
                reachability = value
            }
            try requireTrue(page, "__validate()", config.operationMs)
            try requireTrue(page, "__clear()", config.operationMs)
            return Reading(name: cohort.name, suspended: suspended, ended: ended, reachability: reachability)
        } catch {
            let primary = error
            do { try requireTrue(page, "__clear()", config.operationMs) }
            catch { throw ProbeError(description: "\(primary); cleanup also failed: \(error)") }
            throw primary
        }
    }

    var groups: [Group] = []
    for owner in config.owners {
        try requireTrue(page, "globalThis.\(owner.initializer)()", config.operationMs)
        var rows: [Reading] = []
        for cohort in config.cohorts {
            do {
                rows.append(try sample(cohort, trackInput: config.traceInputs && owner.name == "terminal caller reference"))
            } catch {
                let completed = try JSONEncoder().encode(Output(groups: groups + [Group(owner: owner.name, rows: rows)]))
                throw ProbeError(description: "\(owner.name), \(cohort.name): \(error); completed readings: \(String(decoding: completed, as: UTF8.self))")
            }
        }
        groups.append(Group(owner: owner.name, rows: rows))
    }
    return Output(groups: groups)
}

do {
    let config = try JSONDecoder().decode(Configuration.self, from: FileHandle.standardInput.readDataToEndOfFile())
    let output = try JSONEncoder().encode(measure(config))
    FileHandle.standardOutput.write(output)
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
