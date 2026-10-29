import Foundation
// Called only with a placeholder inside the scoped inbox. No recursive traversal.
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let name = input.lastPathComponent
let target = name.hasPrefix(".") && name.hasSuffix(".icloud")
    ? input.deletingLastPathComponent().appendingPathComponent(String(name.dropFirst().dropLast(7))) : input
try FileManager.default.startDownloadingUbiquitousItem(at: target)
