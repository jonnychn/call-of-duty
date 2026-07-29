// Keyboard + pointer-lock mouse input. Mouse deltas accumulate between frames
// and are drained by the camera controller so no motion is dropped or applied
// twice when the browser delivers several move events per frame.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.buttons = new Set();
    this.locked = false;
    this._pressedThisFrame = new Set();
    this._clickedThisFrame = new Set();

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this._pressedThisFrame.add(e.code);
      // Space and the movement keys scroll the page otherwise.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => { this.keys.clear(); this.buttons.clear(); };

    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (!this.locked) return;
      this.buttons.add(e.button);
      this._clickedThisFrame.add(e.button);
    };
    this._onMouseUp = (e) => this.buttons.delete(e.button);
    this._onWheel = (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.keys.clear(); this.buttons.clear(); }
      if (this.onLockChange) this.onLockChange(this.locked);
    };
    this._onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  requestLock() {
    if (!this.locked) this.canvas.requestPointerLock?.();
  }

  down(code) { return this.keys.has(code); }
  /** True only on the frame the key went down. */
  pressed(code) { return this._pressedThisFrame.has(code); }
  mouseDown(btn) { return this.buttons.has(btn); }
  /** True only on the frame the button went down. */
  clicked(btn) { return this._clickedThisFrame.has(btn); }

  /** Returns and zeroes accumulated look delta. Call once per frame. */
  consumeLook() {
    const dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = 0; this.mouseDY = 0;
    return [dx, dy];
  }

  /** Clears one-frame edge state. Call at the very end of the frame. */
  endFrame() {
    this._pressedThisFrame.clear();
    this._clickedThisFrame.clear();
    this.wheel = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
