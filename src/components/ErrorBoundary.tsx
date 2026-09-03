import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label shown in the fallback and logged, e.g. the cockpit name. */
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(`[ErrorBoundary${this.props.label ? ` — ${this.props.label}` : ''}] Caught render error:`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '100%', minHeight: '240px', padding: '24px', textAlign: 'center', gap: '8px',
          }}
        >
          <span className="mono" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--col-r)' }}>
            {this.props.label ? `${this.props.label} hit an error` : 'Something went wrong'}
          </span>
          <span className="mono" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
            {this.state.error?.message ?? 'Unknown error'}
          </span>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: '8px', padding: '6px 14px', fontSize: '11px', fontWeight: 700,
              letterSpacing: '0.05em', textTransform: 'uppercase',
              background: 'var(--panel2)', border: '1px solid var(--border-dim)',
              color: 'var(--text-secondary)', cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
