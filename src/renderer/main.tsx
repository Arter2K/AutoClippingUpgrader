import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import '../shared/bridge';
import './styles.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <div className="fatal-error"><h1>Не удалось открыть редактор</h1><pre>{this.state.error}</pre><button onClick={() => location.reload()}>Перезагрузить</button></div>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
