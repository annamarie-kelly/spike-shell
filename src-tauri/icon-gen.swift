import AppKit

let srcURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outPath = CommandLine.arguments[2]

let logo = NSImage(contentsOf: srcURL)!
let logoCG = logo.cgImage(forProposedRect: nil, context: nil, hints: nil)!

// Apple icon grid: 1024 canvas, 824pt rounded square, r=185.4, transparent margin
let canvas = 1024, box = 824.0, radius = 185.4
let inset = (Double(canvas) - box) / 2
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let g = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8,
                  bytesPerRow: 0, space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let rect = CGRect(x: inset, y: inset, width: box, height: box)
let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

// Apple template drop shadow: 12px down, 28px blur, black 30%
g.saveGState()
g.setShadow(offset: CGSize(width: 0, height: -12), blur: 28,
            color: CGColor(gray: 0, alpha: 0.3))
g.addPath(path)
g.setFillColor(CGColor(gray: 0, alpha: 1))
g.fillPath()
g.restoreGState()

// Sheen: tile is a vertical gradient (lighter up top), not flat black
g.saveGState()
g.addPath(path)
g.clip()
let tileColors = [CGColor(gray: 0.17, alpha: 1), CGColor(gray: 0.03, alpha: 1)] as CFArray
let tileGrad = CGGradient(colorsSpace: space, colors: tileColors, locations: [0, 1])!
g.drawLinearGradient(tileGrad,
                     start: CGPoint(x: 512, y: rect.maxY),
                     end: CGPoint(x: 512, y: rect.minY), options: [])

// White logo over the tile
g.interpolationQuality = .high
g.draw(logoCG, in: rect)

// Faint inner rim light, strongest at the top edge
let rimColors = [CGColor(gray: 1, alpha: 0.35), CGColor(gray: 1, alpha: 0.06)] as CFArray
let rimGrad = CGGradient(colorsSpace: space, colors: rimColors, locations: [0, 1])!
g.saveGState()
g.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    .copy(strokingWithWidth: 5, lineCap: .butt, lineJoin: .miter, miterLimit: 10))
g.clip()
g.drawLinearGradient(rimGrad,
                     start: CGPoint(x: 512, y: rect.maxY),
                     end: CGPoint(x: 512, y: rect.minY), options: [])
g.restoreGState()
g.restoreGState()

let rep = NSBitmapImageRep(cgImage: g.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath)")
