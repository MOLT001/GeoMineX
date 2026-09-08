'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { IS_DEV } from '@/lib/env';

/**
 * Root render-error boundary — PRD §9.13, §10.5.
 *
 * The requirement is specific: catch render failures "without exposing stack
 * traces or internal state to the user". That matters more here than in a
 * typical app, because the values flowing through these components are
 * extracted from third-party PDFs and produced by a model — an error message
 * echoing the input could put document contents on screen for someone not
 * authorised to see them.
 *
 * So the fallback says nothing about the error. In development the details go
 * to the console, where a developer can see them and a user cannot.
 */
interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (IS_DEV) {
      console.error('Render error:', error, info.componentStack);
    }
    // Production wiring for an error reporter belongs here, with scrubbing —
    // never send raw component props, which may carry document text.
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="font-serif text-2xl font-semibold text-primary-dark">
          Something went wrong
        </h1>
        <p className="text-text-muted">
          The page could not be displayed. Reloading usually fixes it. If it keeps happening, tell
          your administrator what you were doing at the time.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-sih-blue px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Reload the page
        </button>
      </main>
    );
  }
}
