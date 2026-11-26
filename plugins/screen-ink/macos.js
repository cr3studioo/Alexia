// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overlay on a Mac: one `osascript` holding a clear window over each screen, at the screen
 * saver's level, that ignores the mouse. The script is constant; what to draw arrives on stdin.
 *
 * **One window per screen**, because with separate Spaces (the default) a window shows on only
 * one. Every shape goes into every window and each shows the part that is its own.
 *
 * **Coordinates** are points from the top left of the main display, as `computer.screenshot`
 * reports them. AppKit counts from the bottom, so `local` is the one place that is undone.
 */
export const SCRIPT = `
ObjC.import('Cocoa');
ObjC.import('stdlib');

const send = (answer) => $.NSFileHandle.fileHandleWithStandardOutput.writeData(
  $(JSON.stringify(answer).concat(String.fromCharCode(10))).dataUsingEncoding($.NSUTF8StringEncoding));

const paint = (hex) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(
  parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, 1);

const view = (x, y, w, h) => $.NSView.alloc.initWithFrame($.NSMakeRect(x, y, w, h));

// A rectangle with an edge, a fill or both. 4 is NSBoxCustom, 1 a line border, 0 no title.
const block = (x, y, w, h, radius, fill, edge, thick) => {
  const box = $.NSBox.alloc.initWithFrame($.NSMakeRect(x, y, w, h));
  box.setBoxType(4);
  box.setTitlePosition(0);
  box.setBorderType(1);
  box.setContentViewMargins($.NSMakeSize(0, 0));
  box.setCornerRadius(radius);
  box.setBorderWidth(thick);
  box.setBorderColor(edge ? paint(edge) : $.NSColor.clearColor);
  box.setFillColor(fill ? paint(fill) : $.NSColor.clearColor);
  return box;
};

const label = (words, fill, ink) => {
  const field = $.NSTextField.labelWithString($(words));
  field.setFont($.NSFont.boldSystemFontOfSize(14));
  field.setTextColor(paint(ink));
  field.setDrawsBackground(true);
  field.setBackgroundColor(paint(fill));
  field.sizeToFit;
  return field;
};

// An arrow, drawn into a picture just big enough to hold it. Both ends are in window points.
const arrow = (fromX, fromY, tipX, tipY, hex) => {
  const pad = 20;
  const left = Math.min(fromX, tipX) - pad, low = Math.min(fromY, tipY) - pad;
  const wide = Math.abs(tipX - fromX) + 2 * pad, tall = Math.abs(tipY - fromY) + 2 * pad;
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const head = Math.min(18, Math.hypot(tipX - fromX, tipY - fromY));
  const baseX = tipX - head * Math.cos(angle), baseY = tipY - head * Math.sin(angle);
  const sideX = head * 0.6 * Math.sin(angle), sideY = head * 0.6 * Math.cos(angle);
  const at = (x, y) => $.NSMakePoint(x - left, y - low);
  const picture = $.NSImage.alloc.initWithSize($.NSMakeSize(wide, tall));
  picture.lockFocus;
  paint(hex).set;
  const line = $.NSBezierPath.bezierPath;
  line.setLineWidth(5);
  line.moveToPoint(at(fromX, fromY));
  line.lineToPoint(at(baseX, baseY));
  line.stroke;
  const point = $.NSBezierPath.bezierPath;
  point.moveToPoint(at(tipX, tipY));
  point.lineToPoint(at(baseX + sideX, baseY - sideY));
  point.lineToPoint(at(baseX - sideX, baseY + sideY));
  point.closePath;
  point.fill;
  picture.unlockFocus;
  const holder = $.NSImageView.alloc.initWithFrame($.NSMakeRect(left, low, wide, tall));
  holder.setImageScaling(2); // none
  holder.setImage(picture);
  return holder;
};

function run() {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // accessory: no Dock icon, and nothing here ever activates it

  const screens = $.NSScreen.screens;
  const top = screens.objectAtIndex(0).frame.size.height;
  const panes = [];
  for (let i = 0; i < Number(screens.count); i++) {
    const frame = screens.objectAtIndex(i).frame;
    const window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(frame, 0, 2, false); // borderless, buffered
    window.setReleasedWhenClosed(false);
    window.setOpaque(false);
    window.setBackgroundColor($.NSColor.clearColor);
    window.setHasShadow(false);
    window.setIgnoresMouseEvents(true);
    window.setLevel(1000); // NSScreenSaverWindowLevel
    // Every Space (1), stays put (16), not in the window cycle (64), over full-screen apps (256).
    window.setCollectionBehavior(1 | 16 | 64 | 256);
    const w = frame.size.width, h = frame.size.height;
    const shapes = view(0, 0, w, h);
    window.contentView.addSubview(shapes);
    // Her cursor: the middle of the dot is 30, 40 inside its own view.
    const pointer = view(0, 0, 400, 52);
    pointer.addSubview(block(20, 30, 20, 20, 10, '#7C5CFF', '#FFFFFF', 3));
    pointer.setHidden(true);
    window.contentView.addSubview(pointer);
    window.orderFrontRegardless;
    panes.push({ window, shapes, pointer, name: null, x: frame.origin.x, y: frame.origin.y, w, h });
  }

  // A caller's point, in one window's own coordinates.
  const local = (pane, x, y) => [x - pane.x, top - y - pane.y];

  const drawOne = (pane, layer, shape) => {
    const [x, y] = local(pane, shape.x, shape.y);
    let labelX = x, labelTop = y;
    if (shape.kind === 'box') {
      layer.addSubview(block(x, y - shape.h, shape.w, shape.h, 6, null, shape.color, 4));
      // Above the box, or inside its top edge when there is no room above.
      labelTop = y + 28;
      if (labelTop > pane.h) { labelTop = y - 6; labelX = x + 6; }
    } else if (shape.kind === 'arrow') {
      const [tipX, tipY] = local(pane, shape.to.x, shape.to.y);
      layer.addSubview(arrow(x, y, tipX, tipY, shape.color));
    } else if (shape.kind === 'dot') {
      layer.addSubview(block(x - shape.w / 2, y - shape.w / 2, shape.w, shape.w, shape.w / 2, shape.color, null, 0));
      labelX = x + shape.w / 2 + 6;
      labelTop = y + 12;
    }
    if (shape.text) {
      const field = label(shape.text, shape.color, shape.on);
      // A label hangs below its top edge.
      field.setFrameOrigin($.NSMakePoint(labelX, labelTop - field.frame.size.height));
      layer.addSubview(field);
    }
  };

  let batches = [];
  let cursor = null; // { path, step, started, until }

  const remove = (batch) => batch.layers.forEach((layer) => layer.removeFromSuperview);

  const hideCursor = () => { cursor = null; panes.forEach((pane) => pane.pointer.setHidden(true)); };

  const place = (now) => {
    const at = Math.min(cursor.path.length - 1, Math.floor((now - cursor.started) / cursor.step));
    for (const pane of panes) {
      const [x, y] = local(pane, cursor.path[at][0], cursor.path[at][1]);
      pane.pointer.setFrameOrigin($.NSMakePoint(x - 30, y - 40));
    }
  };

  const carryOut = (command) => {
    const now = Date.now();
    if (command.cmd === 'draw') {
      const layers = panes.map((pane) => {
        const layer = view(0, 0, pane.w, pane.h);
        for (const shape of command.shapes) drawOne(pane, layer, shape);
        pane.shapes.addSubview(layer);
        return layer;
      });
      batches.push({ layers, until: now + command.ttl_ms });
      // However often it is asked, only the newest hundred drawings stay.
      while (batches.length > 100) remove(batches.shift());
    } else if (command.cmd === 'clear') {
      batches.forEach(remove);
      batches = [];
      hideCursor();
    } else if (command.cmd === 'cursor') {
      cursor = { path: command.path, step: command.step_ms, started: now, until: now + command.hide_ms };
      for (const pane of panes) {
        if (pane.name) pane.name.removeFromSuperview;
        pane.name = label(command.label, '#7C5CFF', '#FFFFFF');
        pane.name.setFrameOrigin($.NSMakePoint(42, 12));
        pane.pointer.addSubview(pane.name);
        pane.pointer.setHidden(false);
      }
      place(now);
    } else {
      throw new TypeError('unknown command');
    }
    panes.forEach((pane) => pane.window.orderFrontRegardless);
  };

  const input = $.NSFileHandle.fileHandleWithStandardInput;
  let rest = '';

  ObjC.registerSubclass({
    name: 'AlexiaInkListener',
    methods: {
      'read:': {
        types: ['void', ['id']],
        implementation: () => {
          const data = input.availableData;
          if (Number(data.length) === 0) $.exit(0); // stdin ended: nobody is left to take this down
          // The commands are plain ASCII, so no chunk can split a character.
          const lines = (rest + ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))).split('\\n');
          rest = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            let id = null;
            try {
              const command = JSON.parse(line);
              if (command.cmd === 'quit') $.exit(0);
              id = command.id;
              carryOut(command);
              send({ id, ok: true });
            } catch (error) {
              // The kind of error only: its message can quote what was being drawn.
              send({ id, ok: false, error: error.name });
            }
          }
          input.waitForDataInBackgroundAndNotify;
        },
      },
      'tick:': {
        types: ['void', ['id']],
        implementation: () => {
          const now = Date.now();
          batches.filter((batch) => batch.until <= now).forEach(remove);
          batches = batches.filter((batch) => batch.until > now);
          if (cursor && cursor.until <= now) hideCursor();
          else if (cursor) place(now);
        },
      },
    },
  });

  const listener = $.AlexiaInkListener.alloc.init;
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(
    listener, 'read:', $.NSFileHandleDataAvailableNotification, input);
  input.waitForDataInBackgroundAndNotify;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1 / 60, listener, 'tick:', $(), true);

  send({ ready: true, screens: panes.length });
  app.run;
}
`

export const macos = () => ({ command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', SCRIPT] })
