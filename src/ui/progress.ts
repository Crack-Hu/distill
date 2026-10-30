/**
 * Shared progress overlay for long-running LLM calls.
 *
 * Styling matches the distill summary generation dialog: a top rule with the
 * title, a spinner line, the model in use (dimmed), and a footer hint for the
 * cancel key. No left/right borders — every row is padded to the full box
 * width and filled with the panel background, so the layer below is fully
 * covered regardless of row content.
 */

import type {
  Component,
  KeybindingsManager,
  Theme,
  TUI,
} from "@earendil-works/pi-tui";

export interface ProgressDialogOptions {
  /** Short title shown in the top rule, e.g. "Compacting context". */
  title: string;
  /** Spinner line text without the leading spinner, e.g. "Generating summary…". */
  message: string;
  /** Model identifier shown dimmed below the spinner line. */
  modelLabel: string;
}

// Braille dots: eastAsianWidth() says 1 column, but some terminals/fonts
// render them 2 columns wide. Count them conservatively as 2 so the box
// border never overflows and wraps — a 1-column render just leaves one
// extra space before the right border.
const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * Visible width of a (possibly styled) string. Braille dot characters are
 * counted as 2 columns to stay safe across terminals (see SPINNER_FRAMES).
 */
function visibleWidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp >= 0x2800 && cp <= 0x28ff ? 2 : 1;
  }
  return w;
}

/**
 * Cancellable progress dialog. Escape (tui.select.cancel, honoring user
 * keybinding config) closes it with "cancel"; a settled generation closes it
 * with "done" (success or failure — the caller re-awaits to see errors).
 */
export class ProgressDialog implements Component {
  static readonly BOX_W = 52;
  private settled = false;
  private frame = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly finish: (result: "done" | "cancel") => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    generation: Promise<unknown>,
    private readonly options: ProgressDialogOptions,
    done: (result: "done" | "cancel") => void,
  ) {
    this.finish = (result) => {
      if (this.settled) return;
      this.settled = true;
      if (this.ticker) clearInterval(this.ticker);
      done(result);
    };
    // Close the dialog when the generation settles, success or failure.
    void generation.then(
      () => this.finish("done"),
      () => this.finish("done"),
    );
    this.ticker = setInterval(() => {
      this.frame++;
      this.tui.requestRender();
    }, 100);
  }

  handleInput(data: string): void {
    // Match the same cancel key pi's select dialogs use (Esc by default).
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish("cancel");
    }
  }

  render(width: number): string[] {
    const W = Math.min(width, ProgressDialog.BOX_W);
    const { theme } = this;
    const border = (s: string) => theme.fg("border", s);
    const dim = (s: string) => theme.fg("dim", s);
    const accent = (s: string) => theme.fg("accent", s);
    // Panel row: right-pad the (possibly styled) line to the full box width,
    // then fill the whole row with the panel background so the layer below
    // never shows through between rows (no side borders to do that job).
    const panel = (styled: string) =>
      theme.bg(
        "selectedBg",
        styled + " ".repeat(Math.max(0, W - visibleWidth(styled))),
      );

    const title = ` ${this.options.title} `;
    const top = border(
      `┌─${title}${`─`.repeat(Math.max(0, W - visibleWidth(title) - 4))}─┐`,
    );
    const bottom = border(`└${`─`.repeat(W - 2)}┘`);
    const spin = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
    const key = this.keybindings.getKeys("tui.select.cancel")?.[0] ?? "esc";
    const indent = "  ";

    return [
      panel(top),
      panel(""),
      panel(indent + accent(spin) + ` ${this.options.message}`),
      panel(""),
      panel(indent + dim(`Model: ${this.options.modelLabel}`)),
      panel(""),
      panel(indent + dim(`${key} to cancel`)),
      panel(bottom),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
  }
}
