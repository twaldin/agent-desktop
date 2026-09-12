import CoreGraphics
import Dispatch
import Darwin

// Presentation-only flag sampling. Never request Input Monitoring permission or
// collect character events. Preflight is deliberately conservative: denial means
// unavailable, not proof that a modifier was released.
func finish(_ result: String) -> Never {
    print(result)
    fflush(stdout)
    exit(0)
}

guard CommandLine.arguments.count == 2 else { finish("unavailable") }
let mask: CGEventFlags
switch CommandLine.arguments[1] {
case "meta": mask = .maskCommand
case "control": mask = .maskControl
case "alt": mask = .maskAlternate
default: finish("unavailable")
}
guard CGPreflightListenEventAccess() else { finish("unavailable") }
let parent = getppid()
guard parent > 1 else { finish("unavailable") }
func sample() {
    guard getppid() == parent, CGPreflightListenEventAccess() else { finish("unavailable") }
    if !CGEventSource.flagsState(.combinedSessionState).contains(mask) { finish("up") }
}
sample()
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(2))
timer.setEventHandler { sample() }
timer.resume()
dispatchMain()
