// Snap Vanish — default settings (shared by popup, background and content script).
globalThis.SNAP_VANISH_DEFAULTS = Object.freeze({
  enabled: true,        // master on/off switch
  sensitivity: 5,       // 1 (strict) … 10 (lenient)
  duration: 3,          // seconds the dust effect takes
  direction: 'right',   // 'right' | 'left' | 'up' | 'down'
  muteMic: true,        // mute the microphone while vanished
  requireSound: true,   // confirm hand snaps with the click sound (when a mic is available)
});
