/**
 * Lightweight CLI spinner for long-running operations.
 *
 * No dependencies — uses raw ANSI escape codes.
 *
 * Usage:
 *   const spin = spinner('Indexing vault...');
 *   // ... do work ...
 *   spin.succeed('Indexed 42 files');
 *
 *   // Or with wrap():
 *   const result = await withSpinner('Indexing vault...', async (s) => {
 *     // ... do work ...
 *     s.update('Processing file 3/10...');
 *     return someResult;
 *   });
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL = 80; // ms between frames

export interface Spinner {
  /** Update the spinner text */
  update(text: string): void;
  /** Stop with a success message (green ✔) */
  succeed(text?: string): void;
  /** Stop with a failure message (red ✗) */
  fail(text?: string): void;
  /** Stop with a warning message (yellow ⚠) */
  warn(text?: string): void;
  /** Stop with an info message (blue ℹ) */
  info(text?: string): void;
  /** Stop the spinner (no icon) */
  stop(): void;
  /** Whether the spinner is currently running */
  readonly isSpinning: boolean;
}

/**
 * Start a spinner with the given text.
 *
 * In non-TTY environments (piped output, CI), prints a static line instead
 * of animating — prevents garbled output in logs.
 */
export function spinner(text: string): Spinner {
  const isTTY = process.stderr.isTTY;

  if (!isTTY) {
    // Non-interactive: just print the text, no animation
    process.stderr.write(`  … ${text}\n`);
    let stopped = false;
    return {
      update(_t: string) { /* no-op in non-TTY */ },
      succeed(t?: string) { if (!stopped) { stopped = true; process.stderr.write(`  ✔ ${t ?? text}\n`); } },
      fail(t?: string) { if (!stopped) { stopped = true; process.stderr.write(`  ✗ ${t ?? text}\n`); } },
      warn(t?: string) { if (!stopped) { stopped = true; process.stderr.write(`  ⚠ ${t ?? text}\n`); } },
      info(t?: string) { if (!stopped) { stopped = true; process.stderr.write(`  ℹ ${t ?? text}\n`); } },
      stop() { stopped = true; },
      get isSpinning() { return !stopped; },
    };
  }

  let frame = 0;
  let currentText = text;
  let running = true;

  const render = () => {
    const symbol = FRAMES[frame % FRAMES.length];
    process.stderr.write(`\r\x1B[K  \x1B[36m${symbol}\x1B[0m ${currentText}`);
    frame++;
  };

  render();
  const timer = setInterval(render, INTERVAL);

  const clear = () => {
    if (!running) return;
    running = false;
    clearInterval(timer);
    process.stderr.write('\r\x1B[K');
  };

  const finish = (icon: string, finalText: string) => {
    clear();
    process.stderr.write(`  ${icon} ${finalText}\n`);
  };

  return {
    update(t: string) {
      if (running) currentText = t;
    },
    succeed(t?: string) { finish('\x1B[32m✔\x1B[0m', t ?? currentText); },
    fail(t?: string) { finish('\x1B[31m✗\x1B[0m', t ?? currentText); },
    warn(t?: string) { finish('\x1B[33m⚠\x1B[0m', t ?? currentText); },
    info(t?: string) { finish('\x1B[34mℹ\x1B[0m', t ?? currentText); },
    stop() { clear(); },
    get isSpinning() { return running; },
  };
}

/**
 * Run an async function with a spinner. Returns the function's result.
 *
 * The spinner auto-succeeds on completion, auto-fails on error.
 * Override by calling spin.succeed()/fail() inside the callback.
 */
export async function withSpinner<T>(
  text: string,
  fn: (spin: Spinner) => Promise<T>,
  opts?: { successText?: string; failText?: string },
): Promise<T> {
  const spin = spinner(text);
  try {
    const result = await fn(spin);
    if (spin.isSpinning) {
      spin.succeed(opts?.successText ?? text);
    }
    return result;
  } catch (err) {
    if (spin.isSpinning) {
      const errMsg = err instanceof Error ? err.message : String(err);
      spin.fail(opts?.failText ?? `${text} — ${errMsg}`);
    }
    throw err;
  }
}
