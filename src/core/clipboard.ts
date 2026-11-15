import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type CliRenderer,
  type ClipboardService,
} from '@opentui/core';

export type CopyOutcome =
  /** Written to the OS clipboard (Windows, macOS, X11 or Wayland). */
  | { status: 'copied'; via: 'system' }
  /** Sent to the terminal via OSC 52 (SSH sessions, or no OS clipboard available). */
  | { status: 'copied'; via: 'terminal'; confirmed: boolean }
  | { status: 'failed'; reason: string };

/**
 * Cross-platform clipboard writer built on OpenTUI's clipboard service:
 *  - local session: native OS clipboard (Win32 / macOS pasteboard / X11 / Wayland, via OpenTUI's native lib),
 *    falling back to OSC 52 if the OS clipboard is unavailable (e.g. headless Linux);
 *  - remote session (SSH): OSC 52 only, so the link lands on *your* machine's clipboard, not the server's.
 */
export class LinkCopier {
  #service: ClipboardService;

  constructor(renderer: CliRenderer) {
    this.#service = createClipboard({
      host: createHostClipboard({ timeoutMs: 3000 }),
      terminal: createRendererClipboardAdapter(renderer),
    });
  }

  async copy(text: string): Promise<CopyOutcome> {
    try {
      const result = await this.#service.writeText(text, { destination: 'best-available' });
      if (result.host.status === 'written') return { status: 'copied', via: 'system' };
      if (result.terminal.status === 'attempted') {
        // OSC 52 is fire-and-forget: "unknown" means the terminal never told us whether it supports it.
        return { status: 'copied', via: 'terminal', confirmed: result.terminal.capability === 'supported' };
      }
      const hostDetail = result.host.status === 'failed' ? result.host.error.message : result.host.status;
      return { status: 'failed', reason: `no clipboard available (system: ${hostDetail}, terminal: ${result.terminal.capability})` };
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.#service.dispose();
    } catch {
      // ignore
    }
  }
}

export function describeCopy(outcome: CopyOutcome): { text: string; ok: boolean } {
  if (outcome.status === 'failed') return { text: `Couldn't copy (${outcome.reason}). Select the link above.`, ok: false };
  if (outcome.via === 'system') return { text: 'Copied to clipboard', ok: true };
  return outcome.confirmed
    ? { text: 'Copied to clipboard (via terminal)', ok: true }
    : { text: 'Sent to clipboard via terminal (OSC 52). If paste is empty, select the link.', ok: true };
}
