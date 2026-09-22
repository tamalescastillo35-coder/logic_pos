import React, { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class RootErrorBoundary extends React.Component<Props, State> {
  public state: State = { hasError: false, error: null };
  public props: Props;

  constructor(props: Props) {
    super(props);
    this.props = props;
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('RootErrorBoundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <h2 className="text-lg font-bold text-rose-400">Error al inicializar la aplicación</h2>
            <p className="text-xs text-slate-300">
              Ocurrió un error inesperado al cargar el POS:
            </p>
            <pre className="bg-slate-950 p-3 rounded-lg text-xs text-rose-300 font-mono whitespace-pre-wrap overflow-x-auto border border-rose-900/50">
              {this.state.error?.message || String(this.state.error)}
            </pre>
            {this.state.error?.stack && (
              <pre className="bg-slate-950/70 p-3 rounded-lg text-[10px] text-slate-400 font-mono overflow-x-auto max-h-40 border border-slate-800">
                {this.state.error.stack}
              </pre>
            )}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg transition cursor-pointer"
              >
                Recargar
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.clear();
                  sessionStorage.clear();
                  window.location.reload();
                }}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-lg transition cursor-pointer"
              >
                Limpiar almacenamiento y recargar
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
