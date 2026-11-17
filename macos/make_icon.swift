import Cocoa

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"
let size: CGFloat = 1024

let img = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
    // Squircle background with indigo-violet gradient
    let insetRect = rect.insetBy(dx: 64, dy: 64)
    let bgPath = NSBezierPath(roundedRect: insetRect, xRadius: 210, yRadius: 210)
    let grad = NSGradient(
        starting: NSColor(calibratedRed: 0.31, green: 0.27, blue: 0.90, alpha: 1.0),
        ending: NSColor(calibratedRed: 0.49, green: 0.23, blue: 0.93, alpha: 1.0)
    )
    grad?.draw(in: bgPath, angle: -45)

    // Subtle inner highlight border
    NSColor.white.withAlphaComponent(0.22).setStroke()
    bgPath.lineWidth = 10
    bgPath.stroke()

    // White hand holding a pen
    NSColor.white.setStroke()
    NSColor.white.setFill()

    // Pen body
    let pen = NSBezierPath()
    pen.lineWidth = 42
    pen.lineCapStyle = .round
    pen.lineJoinStyle = .round
    pen.move(to: NSPoint(x: 260, y: 250))
    pen.line(to: NSPoint(x: 375, y: 295))
    pen.line(to: NSPoint(x: 785, y: 705))
    pen.line(to: NSPoint(x: 705, y: 785))
    pen.line(to: NSPoint(x: 295, y: 375))
    pen.close()
    pen.stroke()

    // Pen tip dot / ink line
    let tip = NSBezierPath(ovalIn: NSRect(x: 205, y: 195, width: 58, height: 58))
    tip.fill()

    // Stylized hand gripping the pen
    let hand = NSBezierPath()
    hand.lineWidth = 46
    hand.lineCapStyle = .round
    hand.lineJoinStyle = .round
    // Thumb & index finger wrapping over the pen
    hand.move(to: NSPoint(x: 410, y: 500))
    hand.curve(to: NSPoint(x: 610, y: 525),
               controlPoint1: NSPoint(x: 470, y: 605),
               controlPoint2: NSPoint(x: 565, y: 605))
    // Palm & wrist sweep
    hand.curve(to: NSPoint(x: 810, y: 315),
               controlPoint1: NSPoint(x: 705, y: 470),
               controlPoint2: NSPoint(x: 780, y: 400))
    // Lower fingers / palm base
    hand.move(to: NSPoint(x: 485, y: 385))
    hand.curve(to: NSPoint(x: 685, y: 245),
               controlPoint1: NSPoint(x: 535, y: 295),
               controlPoint2: NSPoint(x: 615, y: 255))
    hand.stroke()

    return true
}

if let tiff = img.tiffRepresentation,
   let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
    try png.write(to: URL(fileURLWithPath: outPath))
}
