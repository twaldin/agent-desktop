import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

func emit(_ value: [String: Any], code: Int32 = 0) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(code)
}
guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]), pid > 0 else {
    emit(["error": "Expected the owned Electron PID."], code: 2)
}
guard AXIsProcessTrusted() else {
    emit(["error": "Accessibility inspection is unavailable; no permission prompt or geometry assumption is permitted."], code: 2)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func rectangle(_ rect: CGRect) -> [String: Double] {
    ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "width": Double(rect.width), "height": Double(rect.height)]
}
let application = AXUIElementCreateApplication(pid)
var windowValue: CFTypeRef?
let windowsError = AXUIElementCopyAttributeValue(application, "AXWindows" as CFString, &windowValue)
let axWindows = windowValue as? [AXUIElement] ?? []
let accessibility: [[String: Any]] = axWindows.map { window in
    var entry: [String: Any] = ["title": attribute(window, "AXTitle") as? String ?? "",
                              "role": attribute(window, "AXRole") as? String ?? ""]
    if let value = attribute(window, "AXFullScreen") as? Bool { entry["fullscreen"] = value }
    if let value = attribute(window, "AXMinimized") as? Bool { entry["minimized"] = value }
    if let value = attribute(window, "AXMain") as? Bool { entry["main"] = value }
    if let rawPosition = attribute(window, "AXPosition"), let rawSize = attribute(window, "AXSize"),
       CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() {
        var position = CGPoint.zero, size = CGSize.zero
        if AXValueGetValue(unsafeBitCast(rawPosition, to: AXValue.self), .cgPoint, &position),
           AXValueGetValue(unsafeBitCast(rawSize, to: AXValue.self), .cgSize, &size) {
            entry["frame"] = rectangle(CGRect(origin: position, size: size))
        }
    }
    return entry
}
let cgWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let owned: [[String: Any]] = cgWindows.compactMap { window in
    guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
    return ["id": window[kCGWindowNumber as String] ?? NSNull(), "pid": pid,
            "name": window[kCGWindowName as String] ?? NSNull(), "frame": rectangle(frame),
            "alpha": window[kCGWindowAlpha as String] ?? NSNull()]
}
let displays: [[String: Any]] = NSScreen.screens.compactMap { screen in
    guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
    let id = CGDirectDisplayID(number.uint32Value), mode = CGDisplayCopyDisplayMode(id)
    return ["id": id, "name": screen.localizedName, "frame": rectangle(CGDisplayBounds(id)),
            "backingScaleFactor": Double(screen.backingScaleFactor),
            "modeWidth": mode?.width ?? 0, "modeHeight": mode?.height ?? 0,
            "pixelWidth": mode?.pixelWidth ?? 0, "pixelHeight": mode?.pixelHeight ?? 0]
}
emit(["pid": pid, "frontmostPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
      "cgWindows": owned, "axWindows": accessibility, "axWindowsError": windowsError.rawValue, "accessibilityTrusted": true, "displays": displays])
