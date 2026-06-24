// Native macOS OCR via the Vision framework. Free, local, no API key.
// Reads an image file path, prints recognized text (one observation per line).
// Uses the modern RecognizeTextRequest (macOS 15+) which handles VERTICAL Japanese
// (novels/manga); falls back to VNRecognizeTextRequest on older systems.
// Build: swiftc -O native/ocr.swift -o bin/mac-ocr
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write("usage: mac-ocr <image-path>\n".data(using: .utf8)!)
  exit(2)
}
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot load image\n".data(using: .utf8)!)
  exit(1)
}

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

if #available(macOS 15.0, *) {
  let sem = DispatchSemaphore(value: 0)
  Task {
    do {
      var req = RecognizeTextRequest()
      req.recognitionLanguages = [Locale.Language(identifier: "ja"), Locale.Language(identifier: "en")]
      req.usesLanguageCorrection = true
      req.recognitionLevel = .accurate
      let results = try await req.perform(on: cg)
      let lines = results.compactMap { $0.topCandidates(1).first?.string }
      print(lines.joined(separator: "\n"))
    } catch {
      fail("ocr failed: \(error)")
    }
    sem.signal()
  }
  sem.wait()
} else {
  let request = VNRecognizeTextRequest { req, _ in
    let obs = (req.results as? [VNRecognizedTextObservation]) ?? []
    print(obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n"))
  }
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["ja", "en"]
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  do { try handler.perform([request]) } catch { fail("ocr failed: \(error)") }
}
