import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

func nativeInspectionRetryable(_ arguments: [String], transient: Bool, verifiedWindowID: UInt32?) -> Bool {
  guard transient, arguments.count >= 3, arguments[1] == "inspect" else { return false }
  if arguments.count == 3 { return true }
  guard arguments.count == 4, let verifiedWindowID, verifiedWindowID > 0 else { return false }
  return UInt32(arguments[3]) == verifiedWindowID
}

#if !FILE_EDITOR_GEOMETRY_POLICY_GATE
// Compile this fixture only after Main freezes source. Native keys are
// admitted only for the verified foreground PID/window, as one unpaused CGEvent batch.
func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
// [DEBUG-file-editor-native-routing] Only the fixture's random source tag is
// observed. Unrelated event payloads are neither inspected nor retained.
final class NativeRoutingContext {
  let tag: Int64
  let stage: String
  var failed = false
  init(_ tag: Int64, _ stage: String) { self.tag = tag; self.stage = stage }
}
func routingRecord(_ value: [String: Any]) {
  var record = value
  record["probe"] = "DEBUG-file-editor-native-routing"
  guard let bytes = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { fail("Native routing record could not be encoded") }
  FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data("\n".utf8))
}
// Only the fixture's own pointer batch (move/down/up) joins the tagged record
// stream; the tag guard below still drops every unrelated mouse or key event.
let pointerEventTypes: Set<CGEventType> = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp]
func pointerFields(_ event: CGEvent) -> [String: Any] {
  guard pointerEventTypes.contains(event.type) else { return [:] }
  return ["mouseButton": event.getIntegerValueField(.mouseEventButtonNumber), "clickState": event.getIntegerValueField(.mouseEventClickState),
    "location": ["x": event.location.x, "y": event.location.y]]
}
let routingCallback: CGEventTapCallBack = { _, type, event, info in
  guard let info else { return Unmanaged.passUnretained(event) }
  let context = Unmanaged<NativeRoutingContext>.fromOpaque(info).takeUnretainedValue()
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    context.failed = true
    routingRecord(["phase": "disabled", "stage": context.stage, "type": type.rawValue, "uptime": ProcessInfo.processInfo.systemUptime])
    CFRunLoopStop(CFRunLoopGetMain())
    return Unmanaged.passUnretained(event)
  }
  guard event.getIntegerValueField(.eventSourceUserData) == context.tag else { return Unmanaged.passUnretained(event) }
  var record: [String: Any] = ["phase": "event", "tag": String(context.tag), "stage": context.stage, "type": type.rawValue,
    "keyCode": event.getIntegerValueField(.keyboardEventKeycode), "flags": event.flags.rawValue,
    "sourcePID": event.getIntegerValueField(.eventSourceUnixProcessID), "targetPID": event.getIntegerValueField(.eventTargetUnixProcessID),
    "sourceStateID": event.getIntegerValueField(.eventSourceStateID), "eventTimestamp": String(event.timestamp),
    "uptime": ProcessInfo.processInfo.systemUptime]
  for (key, value) in pointerFields(event) { record[key] = value }
  routingRecord(record)
  return Unmanaged.passUnretained(event)
}
let arguments = CommandLine.arguments
 guard arguments.count >= 3, let pid = Int32(arguments[2]), pid > 0 else { fail("Usage: native inspect|keys|trace|pointer|capture PID [WINDOW_ID] [JSON]") }
var verifiedWindowID: UInt32?
func refuse(_ stage: String, _ message: String, retryable: Bool = false, details: [String: Any] = [:]) -> Never {
  let canRetry = nativeInspectionRetryable(arguments, transient: retryable, verifiedWindowID: verifiedWindowID)
  var report: [String: Any] = ["status": "refused", "stage": stage, "message": message, "pid": pid, "retryable": canRetry,
    "executable": NSRunningApplication(processIdentifier: pid)?.executableURL?.resolvingSymlinksInPath().path ?? "", "wallTime": Date().timeIntervalSince1970 * 1000]
  if let verifiedWindowID { report["windowId"] = verifiedWindowID }
  for (key, value) in details { report[key] = value }
  guard let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) else { fail(message) }
  FileHandle.standardError.write(bytes); FileHandle.standardError.write(Data("\n".utf8)); exit(canRetry ? 75 : 1)
}
let traceTag: Int64? = {
  guard let value = ProcessInfo.processInfo.environment["FILE_EDITOR_NATIVE_TRACE_TAG"] else { return nil }
  guard let tag = Int64(value), tag > 0 else { fail("Native routing requires a positive fixture-only tag") }
  return tag
}()
guard let inventory = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { refuse("cg-list", "CG window inventory is unavailable") }
let owned = inventory.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == Int(pid) }
let descriptors: [[String: Any]] = owned.map { window in
  ["id": (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0,
   "layer": (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1,
   "onScreen": (window[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
   "alpha": (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0,
   "bounds": window[kCGWindowBounds as String] as? [String: Any] ?? [:]]
}
let windows = owned.filter { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 && ($0[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true }
if windows.isEmpty { refuse("cg-pending", "The verified main PID has not published an ordinary CG window", retryable: true, details: ["ownedWindows": descriptors]) }
guard windows.count == 1, let window = windows.first else { refuse("cg-ambiguous", "Owned PID must have exactly one ordinary CG window", details: ["ownedWindows": descriptors]) }
guard let number = window[kCGWindowNumber as String] as? NSNumber, let id = UInt32(exactly: number.int64Value), id > 0 else { refuse("cg-id", "The unique owned CG window has no valid numeric ID", details: ["ownedWindows": descriptors]) }
guard let rawBounds = window[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: rawBounds) else { refuse("cg-bounds", "The unique owned CG window has invalid bounds", details: ["ownedWindows": descriptors]) }
if arguments.count > 3, UInt32(arguments[3]) != id { refuse("cg-owner-changed", "The owned CG window changed", details: ["expectedWindow": arguments[3], "ownedWindows": descriptors]) }
verifiedWindowID = id
let application = AXUIElementCreateApplication(pid)
var rawAX: CFTypeRef?
// Private no-input admission probe only. Keep diagnostics off stdout/stderr so
// the original geometry/refusal protocol and its single-shot guards stay exact.
let axDiagnostic: FileHandle? = {
  guard let output = ProcessInfo.processInfo.environment["FILE_EDITOR_ACCEPTANCE_OUTPUT"],
    FileManager.default.fileExists(atPath: output + "/observer-admission-only.json") else { return nil }
  let path = output + "/observer-ax-call-\(ProcessInfo.processInfo.processIdentifier).jsonl"
  guard FileManager.default.createFile(atPath: path, contents: nil),
    let handle = FileHandle(forWritingAtPath: path) else { fail("Owned AX diagnostic output is unavailable") }
  return handle
}()
func recordAXCall(_ phase: String, fields: [String: Any] = [:]) {
  guard let axDiagnostic else { return }
  var value: [String: Any] = ["phase": phase, "operation": arguments[1],
    "helperPID": ProcessInfo.processInfo.processIdentifier, "targetPID": pid, "verifiedWindowID": id,
    "attribute": kAXWindowsAttribute as String, "wallTime": Date().timeIntervalSince1970 * 1000,
    "uptime": ProcessInfo.processInfo.systemUptime, "timeoutConfiguration": "system-default; this helper sets no override",
    "timeoutSeconds": NSNull(), "timeoutQualification": "The AX API exposes no messaging-timeout getter; duration is unknown."]
  for (key, field) in fields { value[key] = field }
  guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { fail("Owned AX diagnostic could not be encoded") }
  axDiagnostic.write(bytes); axDiagnostic.write(Data("\n".utf8))
}
recordAXCall("before-call")
let axCallStart: TimeInterval? = axDiagnostic == nil ? nil : ProcessInfo.processInfo.systemUptime
let axError = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &rawAX)
if let axCallStart {
  let end = ProcessInfo.processInfo.systemUptime
  recordAXCall("after-call", fields: ["callStartUptime": axCallStart, "callEndUptime": end,
    "elapsedMilliseconds": (end - axCallStart) * 1000, "axError": axError.rawValue,
    "returnedWindowCount": (rawAX as? [AXUIElement]).map { $0.count as Any } ?? NSNull()])
  axDiagnostic?.closeFile()
}
guard axError == .success else { refuse("ax-list", "Owned AX window inventory is unavailable", retryable: axError == .cannotComplete, details: ["axError": axError.rawValue, "ownedWindows": descriptors]) }
guard let axWindows = rawAX as? [AXUIElement] else { refuse("ax-list-shape", "Owned AX window inventory has an invalid shape", details: ["axError": axError.rawValue, "ownedWindows": descriptors]) }
if axWindows.isEmpty { refuse("ax-pending", "The verified CG window has not published an AX window", retryable: true, details: ["axError": axError.rawValue, "ownedWindows": descriptors]) }
guard axWindows.count == 1 else { refuse("ax-ambiguous", "Owned AX window must be unique", details: ["axWindowCount": axWindows.count, "ownedWindows": descriptors]) }
func attribute(_ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(axWindows[0], name, &value)
  guard error == .success else { refuse("ax-attribute", "Owned AX geometry attribute is unavailable", retryable: error == .cannotComplete, details: ["attribute": name as String, "axError": error.rawValue, "ownedWindows": descriptors]) }
  return value
}
guard let position = attribute(kAXPositionAttribute as CFString), let size = attribute(kAXSizeAttribute as CFString),
  CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { fail("AX geometry unavailable") }
var point = CGPoint.zero, extent = CGSize.zero
AXValueGetValue(position as! AXValue, .cgPoint, &point)
AXValueGetValue(size as! AXValue, .cgSize, &extent)
let axBounds = CGRect(origin: point, size: extent)
guard bounds == axBounds else {
  refuse("geometry-pending", "CG and AX bounds disagree", retryable: true, details: [
    "windowId": id,
    "cgBounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height],
    "axBounds": ["x": axBounds.minX, "y": axBounds.minY, "width": axBounds.width, "height": axBounds.height]
  ])
}
let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
if arguments[1] == "trace" {
  guard arguments.count == 4, frontmost, let tag = traceTag else { fail("Native routing requires the owned foreground window and fixture tag") }
  // Preflight never requests permission. Missing access is a capability refusal,
  // not permission to continue input with a partial or fabricated route trace.
  guard CGPreflightListenEventAccess() else { refuse("routing-listen-access", "Existing event-listening access is unavailable; no permission was requested") }
  let observedTypes: [CGEventType] = [.keyDown, .keyUp, .flagsChanged] + pointerEventTypes.sorted { $0.rawValue < $1.rawValue }
  let mask = observedTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
  let contexts = [NativeRoutingContext(tag, "session-head"), NativeRoutingContext(tag, "annotated-session-tail"), NativeRoutingContext(tag, "owned-pid-tail")]
  var taps: [CFMachPort] = []
  var sources: [CFRunLoopSource] = []
  for context in contexts {
    let info = Unmanaged.passUnretained(context).toOpaque()
    let tap: CFMachPort?
    if context.stage == "owned-pid-tail" {
      tap = CGEvent.tapCreateForPid(pid: pid, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask, callback: routingCallback, userInfo: info)
    } else {
      tap = CGEvent.tapCreate(tap: context.stage == "session-head" ? .cgSessionEventTap : .cgAnnotatedSessionEventTap,
        place: context.stage == "session-head" ? .headInsertEventTap : .tailAppendEventTap,
        options: .listenOnly, eventsOfInterest: mask, callback: routingCallback, userInfo: info)
    }
    guard let tap, CGEvent.tapIsEnabled(tap: tap), let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
      for tap in taps { CFMachPortInvalidate(tap) }
      refuse("routing-tap-unavailable", "A passive native routing stage could not be installed", details: ["stage": context.stage])
    }
    taps.append(tap); sources.append(source)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
  }
  DispatchQueue.global().async {
    _ = readLine()
    CFRunLoopStop(CFRunLoopGetMain())
  }
  CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) {
    routingRecord(["phase": "ready", "pid": pid, "windowId": id, "observerPID": ProcessInfo.processInfo.processIdentifier,
      "tag": String(tag), "stages": contexts.map { $0.stage }, "uptime": ProcessInfo.processInfo.systemUptime])
  }
  withExtendedLifetime(contexts) { CFRunLoopRun() }
  let enabled = taps.allSatisfy { CGEvent.tapIsEnabled(tap: $0) }, failed = contexts.contains { $0.failed }
  for source in sources { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
  for tap in taps { CFMachPortInvalidate(tap) }
  routingRecord(["phase": "stopped", "pid": pid, "tag": String(tag), "enabledBeforeStop": enabled, "failed": failed, "uptime": ProcessInfo.processInfo.systemUptime])
  exit(enabled && !failed ? 0 : 1)
}
func rect(_ value: CGRect) -> [String: CGFloat] { ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height] }
func ownedDisplay() -> (id: CGDirectDisplayID, screen: NSScreen) {
  var display: CGDirectDisplayID = 0, count: UInt32 = 0
  CGGetDisplaysWithPoint(CGPoint(x: bounds.midX, y: bounds.midY), 1, &display, &count)
  guard count == 1, let screen = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32) == display }) else { fail("Owned display is ambiguous") }
  return (display, screen)
}
// Retain sender/source only after all posts, until the owned native observer
// acknowledges the final event. No event is retained or replayed.
func awaitObserverAcknowledgement(_ source: CGEventSource, _ result: [String: Any]) -> Never {
  print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
  fflush(stdout)
  withExtendedLifetime(source) {
    guard readLine() == "observed \(source.userData)" else { fail("The actual final-event observer acknowledgement did not arrive") }
  }
  exit(0)
}
// Real modifier press/release events (CGEvent.h:63–77) shared by key chords and
// modified pointer batches; CGEventCreateKeyboardEvent emits flagsChanged for these codes.
let modifierKeys: [String: (CGKeyCode, CGEventFlags)] = ["Control": (59, .maskControl), "Meta": (55, .maskCommand), "Shift": (56, .maskShift), "Alt": (58, .maskAlternate)]
func namedModifiers(_ names: [String]) -> [(String, CGKeyCode, CGEventFlags)] {
  guard Set(names).count == names.count else { fail("Duplicate native modifier") }
  return names.map { name -> (String, CGKeyCode, CGEventFlags) in
    guard let value = modifierKeys[name] else { fail("Unknown native modifier") }
    return (name, value.0, value.1)
  }
}
if arguments[1] == "keys" || arguments[1] == "focus-sequence" {
  guard (arguments.count == 5 || arguments.count == 6), frontmost, let bytes = arguments[4].data(using: .utf8),
    let chords = try? JSONSerialization.jsonObject(with: bytes) as? [[String: Any]] else { fail("Keys require owned foreground window and JSON chords") }
  guard traceTag != nil else { fail("Native sender ownership requires the fixture's routing tag") }
  let afterFocus: [[String: Any]]
  if arguments[1] == "focus-sequence" {
    guard arguments.count == 6, let bytes = arguments[5].data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: bytes) as? [[String: Any]] else { fail("Focus sequence requires its final native chords") }
    afterFocus = parsed
  } else { afterFocus = [] }
  // ANSI virtual key codes (HIToolbox Events.h). Letters and digits are named by
  // their unshifted character; uppercase text is the letter chord with Shift.
  let codes: [String: CGKeyCode] = [
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37, "m": 46,
    "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    "BracketRight": 30, "BracketLeft": 33, "Minus": 27, "Equal": 24, "Period": 47, "Comma": 43, "Slash": 44, "Semicolon": 41, "Quote": 39, "Backslash": 42, "Backquote": 50,
    "Escape": 53, "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Delete": 117, "Home": 115, "End": 119,
    "ArrowDown": 125, "ArrowUp": 126, "ArrowRight": 124, "ArrowLeft": 123]
  // CGEventSource.h:31–40 recommends combined session state for login-session
  // posting; HID state is for hardware-generating drivers and daemons.
  guard let source = CGEventSource(stateID: .combinedSessionState) else { fail("Native event source is unavailable") }
  if let traceTag { source.userData = traceTag }
  var records: [[String: Any]] = []
  func post(_ key: String, _ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags, modifier: Bool = false) {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { fail("Could not create native key") }
    event.flags = flags
    let sourceUserData = event.getIntegerValueField(.eventSourceUserData)
    event.post(tap: .cghidEventTap)
    records.append(["key": key, "keyCode": Int(code), "flags": flags.rawValue, "down": down, "modifier": modifier,
      "eventType": event.type.rawValue, "sourceUserData": String(sourceUserData), "eventTimestamp": String(event.timestamp), "uptime": ProcessInfo.processInfo.systemUptime, "wallTime": Date().timeIntervalSince1970 * 1000])
  }
  func emit(_ chords: [[String: Any]]) {
    for chord in chords {
      guard let key = chord["key"] as? String, let code = codes[key] else { fail("Unknown native key") }
      let modifiers = namedModifiers(chord["modifiers"] as? [String] ?? [])
      var flags: CGEventFlags = []
      // CGEvent.h:63–77 requires real modifier press/release events, not only
      // flags on the character. The entire requested chord stays unpaused.
      for modifier in modifiers {
        flags.insert(modifier.2); post(modifier.0, modifier.1, true, flags, modifier: true)
      }
      post(key, code, true, flags); post(key, code, false, flags)
      for modifier in modifiers.reversed() {
        flags.remove(modifier.2); post(modifier.0, modifier.1, false, flags, modifier: true)
      }
    }
  }
  emit(chords)
  if !afterFocus.isEmpty {
    guard readLine() == "focus" else { fail("The exact native owner focus event did not arrive") }
    emit(afterFocus)
  }
  let result: [String: Any] = ["pid": pid, "windowId": id, "senderPID": ProcessInfo.processInfo.processIdentifier, "senderLifetime": "observer-ack", "traceTag": String(source.userData), "sourceStateID": source.sourceStateID.rawValue, "events": records, "unpaused": afterFocus.isEmpty, "trigger": afterFocus.isEmpty ? "transaction-start" : "passive-original-owner-focus"]
  awaitObserverAcknowledgement(source, result)
}
if arguments[1] == "pointer" {
  // One unpaused tagged move/down/up at an in-window point (CG top-left points
  // relative to the verified window origin). Optional modifiers are pressed as
  // real key events before the move and released in reverse after the mouse-up;
  // the ACK event is the final post: the mouse-up, or the last modifier release.
  guard arguments.count == 5, frontmost, let bytes = arguments[4].data(using: .utf8),
    let request = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let x = (request["x"] as? NSNumber)?.doubleValue, let y = (request["y"] as? NSNumber)?.doubleValue, let button = request["button"] as? String,
    x.isFinite, y.isFinite else { fail("Pointer requires owned foreground window and a JSON in-window point") }
  guard traceTag != nil else { fail("Native sender ownership requires the fixture's routing tag") }
  guard button == "left" || button == "right" else { fail("Unknown native pointer button") }
  let modifierNames: [String]
  if let raw = request["modifiers"] {
    guard let names = raw as? [String] else { fail("Pointer modifiers must be an array of modifier names") }
    modifierNames = names
  } else { modifierNames = [] }
  let modifiers = namedModifiers(modifierNames)
  let left = button == "left"
  let mouseButton: CGMouseButton = left ? .left : .right
  let downType: CGEventType = left ? .leftMouseDown : .rightMouseDown, upType: CGEventType = left ? .leftMouseUp : .rightMouseUp
  // Preflight never requests permission. Missing posting access is a refusal.
  guard CGPreflightPostEventAccess() else { refuse("pointer-post-access", "Existing event-posting access is unavailable; no permission was requested") }
  guard x >= 0, y >= 0, x < bounds.width, y < bounds.height else {
    refuse("pointer-outside", "The requested point is outside the owned CG window", details: ["point": ["x": x, "y": y], "cgBounds": rect(bounds)])
  }
  let global = CGPoint(x: bounds.minX + x, y: bounds.minY + y)
  // The window server routes the click to the frontmost on-screen window under
  // the point; anything owned by another PID there would receive the input instead.
  guard let stack = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { refuse("cg-list", "CG window inventory is unavailable") }
  let hit = stack.first { window in
    guard let raw = window[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: raw) else { return false }
    return frame.contains(global) && ((window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0
  }
  guard let hit, (hit[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == Int(pid) else {
    refuse("pointer-occluded", "The requested point is not owned by the verified PID's frontmost window", details: ["point": ["x": x, "y": y], "global": ["x": global.x, "y": global.y],
      "hit": hit.map { window -> [String: Any] in ["id": (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0, "pid": (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0, "layer": (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1] } ?? [:], "ownedWindows": descriptors])
  }
  guard let source = CGEventSource(stateID: .combinedSessionState) else { fail("Native event source is unavailable") }
  if let traceTag { source.userData = traceTag }
  var records: [[String: Any]] = []
  var flags: CGEventFlags = []
  // Match the key sender's requested flags; preserve the post-call value separately.
  func append(_ event: CGEvent, _ phase: String, _ sourceUserData: Int64, _ fields: [String: Any]) {
    var record: [String: Any] = ["phase": phase, "button": button, "keyCode": event.getIntegerValueField(.keyboardEventKeycode), "flags": flags.rawValue, "flagsAfterPost": event.flags.rawValue,
      "eventType": event.type.rawValue, "sourceUserData": String(sourceUserData), "eventTimestamp": String(event.timestamp), "uptime": ProcessInfo.processInfo.systemUptime, "wallTime": Date().timeIntervalSince1970 * 1000]
    for (key, value) in fields { record[key] = value }
    for (key, value) in pointerFields(event) { record[key] = value }
    records.append(record)
  }
  func postModifier(_ modifier: (String, CGKeyCode, CGEventFlags), _ down: Bool) {
    if down { flags.insert(modifier.2) } else { flags.remove(modifier.2) }
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: modifier.1, keyDown: down) else { fail("Could not create native modifier key") }
    event.flags = flags
    let sourceUserData = event.getIntegerValueField(.eventSourceUserData)
    event.post(tap: .cghidEventTap)
    append(event, down ? "modifier-down" : "modifier-up", sourceUserData, ["key": modifier.0, "down": down, "modifier": true])
  }
  func postMouse(_ type: CGEventType, _ phase: String) {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: global, mouseButton: mouseButton) else { fail("Could not create native pointer event") }
    event.flags = flags
    if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
    let sourceUserData = event.getIntegerValueField(.eventSourceUserData)
    event.post(tap: .cghidEventTap)
    append(event, phase, sourceUserData, ["modifier": false])
  }
  for modifier in modifiers { postModifier(modifier, true) }
  postMouse(.mouseMoved, "move"); postMouse(downType, "down"); postMouse(upType, "up")
  for modifier in modifiers.reversed() { postModifier(modifier, false) }
  let result: [String: Any] = ["pid": pid, "windowId": id, "senderPID": ProcessInfo.processInfo.processIdentifier, "senderLifetime": "observer-ack", "traceTag": String(source.userData), "sourceStateID": source.sourceStateID.rawValue, "events": records, "unpaused": true, "trigger": "transaction-start",
    "button": button, "modifiers": modifierNames, "point": ["x": x, "y": y], "global": ["x": global.x, "y": global.y], "cgBounds": rect(bounds)]
  awaitObserverAcknowledgement(source, result)
}
if arguments[1] == "capture" {
  // Actual owned CG-window image only (no display region, no other windows),
  // written to a fresh PNG confined to the acceptance output directory.
  guard arguments.count == 5, frontmost else { fail("Capture requires the owned foreground window and an output path") }
  let path = arguments[4]
  guard let output = ProcessInfo.processInfo.environment["FILE_EDITOR_ACCEPTANCE_OUTPUT"], !output.isEmpty else { fail("Capture requires the owned acceptance output directory") }
  let outputRoot = URL(fileURLWithPath: output).resolvingSymlinksInPath().standardizedFileURL.path
  let target = URL(fileURLWithPath: path).standardizedFileURL
  guard path.hasPrefix("/"), target.pathExtension == "png", target.lastPathComponent != ".png",
    target.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL.path == outputRoot,
    !FileManager.default.fileExists(atPath: target.path) else { refuse("capture-path", "Native captures are confined to a fresh PNG directly inside the acceptance output", details: ["path": path, "output": outputRoot]) }
  // Preflight never requests permission. Missing capture access is a refusal.
  guard CGPreflightScreenCaptureAccess() else { refuse("capture-access", "Existing screen-capture access is unavailable; no permission was requested") }
  let captureDisplay = ownedDisplay()
  let scale = captureDisplay.screen.backingScaleFactor
  let started = ProcessInfo.processInfo.systemUptime
  let capture = Process(), captureErrors = Pipe()
  capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  capture.arguments = ["-x", "-o", "-a", "-T", "0", "-l", String(id), target.path]
  capture.standardOutput = FileHandle.nullDevice
  capture.standardError = captureErrors
  do { try capture.run() } catch { refuse("capture-launch", "The native window capture command could not start", details: ["error": String(describing: error)]) }
  let captureStderr = captureErrors.fileHandleForReading.readDataToEndOfFile()
  capture.waitUntilExit()
  guard capture.terminationStatus == 0 else { refuse("capture-image", "The native owned-window capture command failed", details: ["capturePID": capture.processIdentifier, "status": capture.terminationStatus, "stderr": String(data: captureStderr, encoding: .utf8) ?? ""]) }
  guard let imageSource = CGImageSourceCreateWithURL(target as CFURL, nil),
    CGImageSourceGetType(imageSource) as String? == "public.png",
    let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [String: Any],
    let imageWidth = (properties[kCGImagePropertyPixelWidth as String] as? NSNumber)?.intValue,
    let imageHeight = (properties[kCGImagePropertyPixelHeight as String] as? NSNumber)?.intValue else { refuse("capture-image", "The native capture did not produce a readable PNG") }
  let finished = ProcessInfo.processInfo.systemUptime
  guard let after = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first,
    (after[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == Int(pid),
    let rawAfter = after[kCGWindowBounds as String] as? NSDictionary, let boundsAfter = CGRect(dictionaryRepresentation: rawAfter), boundsAfter == bounds,
    NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { refuse("capture-geometry-changed", "The owned window geometry or foreground state changed during capture", details: ["cgBounds": rect(bounds)]) }
  let expected = (width: Int((bounds.width * scale).rounded()), height: Int((bounds.height * scale).rounded()))
  guard imageWidth == expected.width, imageHeight == expected.height else {
    refuse("capture-size", "The owned window image does not match its CG bounds at the display scale", details: ["imageWidth": imageWidth, "imageHeight": imageHeight, "expectedWidth": expected.width, "expectedHeight": expected.height, "scale": scale])
  }
  let result: [String: Any] = ["pid": pid, "windowId": id, "path": target.path, "cgBounds": rect(bounds), "imageWidth": imageWidth, "imageHeight": imageHeight,
    "helperPID": ProcessInfo.processInfo.processIdentifier, "capturePID": capture.processIdentifier, "captureExit": capture.terminationStatus, "captureBackend": "/usr/sbin/screencapture", "captureArguments": capture.arguments ?? [],
    "display": ["id": captureDisplay.id, "scale": scale], "captureStartUptime": started, "captureEndUptime": finished, "uptime": ProcessInfo.processInfo.systemUptime, "wallTime": Date().timeIntervalSince1970 * 1000]
  print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
  exit(0)
}
guard arguments[1] == "inspect" else { fail("Unknown native operation") }
let inspected = ownedDisplay(), display = inspected.id, screen = inspected.screen
guard let displayMode = CGDisplayCopyDisplayMode(display) else { refuse("display-mode", "The owned display mode is unavailable") }
let result: [String: Any] = ["pid": pid, "windowId": id, "cgBounds": rect(bounds), "axBounds": rect(axBounds), "frontmost": frontmost,
  "display": ["id": display, "name": screen.localizedName, "logicalBounds": rect(CGDisplayBounds(display)), "pixelWidth": CGDisplayPixelsWide(display), "pixelHeight": CGDisplayPixelsHigh(display), "scale": screen.backingScaleFactor,
    "mode": ["width": displayMode.width, "height": displayMode.height, "pixelWidth": displayMode.pixelWidth, "pixelHeight": displayMode.pixelHeight]],
  "binary": NSRunningApplication(processIdentifier: pid)?.executableURL?.resolvingSymlinksInPath().path ?? "", "uptime": ProcessInfo.processInfo.systemUptime]
print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
#endif
