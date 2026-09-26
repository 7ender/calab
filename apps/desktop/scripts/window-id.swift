import CoreGraphics
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Calab"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
for w in list {
  if (w[kCGWindowOwnerName as String] as? String) == owner, (w[kCGWindowLayer as String] as? Int) == 0 {
    let b = w[kCGWindowBounds as String] as! [String: Any]
    print(w[kCGWindowNumber as String]!, b["Width"]!, b["Height"]!, w[kCGWindowName as String] ?? "")
  }
}
