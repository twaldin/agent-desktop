import AppKit
import ApplicationServices
import Foundation

func axRead(_ element: AXUIElement, _ attribute: String) -> (value: CFTypeRef?, error: AXError) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return (value, error)
}

func axRecord(_ read: (value: CFTypeRef?, error: AXError)) -> [String: Any] {
    var record: [String: Any] = ["error": read.error.rawValue, "errorName": String(describing: read.error), "value": NSNull()]
    guard let value = read.value else { return record }
    record["typeID"] = CFGetTypeID(value)
    if let text = value as? String {
        record["value"] = text
    } else if let number = value as? NSNumber {
        record["value"] = number
    } else if CFGetTypeID(value) == AXValueGetTypeID() {
        let geometry = value as! AXValue
        record["geometryType"] = AXValueGetType(geometry).rawValue
        switch AXValueGetType(geometry) {
        case .cgPoint:
            var point = CGPoint.zero
            let decoded = AXValueGetValue(geometry, .cgPoint, &point)
            record["decoded"] = decoded
            if decoded { record["value"] = ["x": Double(point.x), "y": Double(point.y)] }
        case .cgSize:
            var size = CGSize.zero
            let decoded = AXValueGetValue(geometry, .cgSize, &size)
            record["decoded"] = decoded
            if decoded { record["value"] = ["width": Double(size.width), "height": Double(size.height)] }
        default:
            break
        }
    }
    return record
}

let arguments = CommandLine.arguments
guard arguments.count == 3, arguments[1] == "metadata", let pid = pid_t(arguments[2]), pid > 0 else {
    fputs("Expected metadata and an owned PID.\n", stderr)
    exit(2)
}
let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
    .filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) }
let axApplication = AXUIElementCreateApplication(pid)
let axWindows = axRead(axApplication, kAXWindowsAttribute)
var axInventory: [String: Any] = [
    "pid": Int(pid), "queryError": axWindows.error.rawValue, "queryErrorName": String(describing: axWindows.error),
    "windowCount": NSNull(), "windows": []
]
if let rawWindows = axWindows.value { axInventory["windowsTypeID"] = CFGetTypeID(rawWindows) }
if let elements = axWindows.value as? [AXUIElement] {
    axInventory["windowCount"] = elements.count
    axInventory["windows"] = elements.enumerated().map { index, element -> [String: Any] in
        var elementPID: pid_t = 0
        let pidError = AXUIElementGetPid(element, &elementPID)
        let position = axRecord(axRead(element, kAXPositionAttribute))
        let size = axRecord(axRead(element, kAXSizeAttribute))
        var entry: [String: Any] = [
            "index": index, "pid": Int(elementPID), "pidError": pidError.rawValue, "pidErrorName": String(describing: pidError),
            "position": position, "size": size, "bounds": NSNull(),
            "role": axRecord(axRead(element, kAXRoleAttribute)),
            "subrole": axRecord(axRead(element, kAXSubroleAttribute)),
            "title": axRecord(axRead(element, kAXTitleAttribute)),
            "main": axRecord(axRead(element, kAXMainAttribute)),
            "focused": axRecord(axRead(element, kAXFocusedAttribute)),
            "minimized": axRecord(axRead(element, kAXMinimizedAttribute))
        ]
        if let point = position["value"] as? [String: Double], let extent = size["value"] as? [String: Double],
           let x = point["x"], let y = point["y"], let width = extent["width"], let height = extent["height"] {
            entry["bounds"] = ["x": x, "y": y, "width": width, "height": height]
        }
        return entry
    }
}
let screens: [[String: Any]] = NSScreen.screens.compactMap { screen in
    guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
          let mode = CGDisplayCopyDisplayMode(CGDirectDisplayID(number.uint32Value)) else { return nil }
    return [
        "id": number.uint32Value,
        "frame": NSStringFromRect(screen.frame),
        "visibleFrame": NSStringFromRect(screen.visibleFrame),
        "backingScale": screen.backingScaleFactor,
        "name": screen.localizedName,
        "mode": ["width": mode.width, "height": mode.height, "pixelWidth": mode.pixelWidth, "pixelHeight": mode.pixelHeight]
    ]
}
let result: [String: Any] = [
    "pid": Int(pid),
    "screenCapturePermission": CGPreflightScreenCaptureAccess(),
    "accessibilityPermission": AXIsProcessTrusted(),
    "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
    "windows": windows,
    "ax": axInventory,
    "screens": screens
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
