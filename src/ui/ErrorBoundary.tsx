import { Component, type ReactNode } from 'react';
import { useKeyboard } from '@opentui/react';
import { theme } from './theme.js';

function QuitOnKey({ onQuit }: { onQuit: () => void }) {
  useKeyboard((key) => {
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) onQuit();
  });
  return null;
}

/**
 * Our own boundary: OpenTUI's built-in one renders through `jsxDEV`, which is undefined when
 * React runs its production build (NODE_ENV=production), so any render error turned into a
 * second, opaque "jsxDEV is not a function" crash.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onQuit: () => void }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error('render error', error);
  }

  override render() {
    if (this.state.error) {
      return (
        <box flexDirection="column" padding={1}>
          <QuitOnKey onQuit={this.props.onQuit} />
          <text fg={theme.error}>peardrop crashed while rendering (press q to quit):</text>
          <text fg={theme.muted}>{this.state.error.stack ?? this.state.error.message}</text>
        </box>
      );
    }
    return this.props.children;
  }
}
