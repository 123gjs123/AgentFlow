import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App.jsx';

/** A render error shows what happened and a way back, instead of a blank page. */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 720 }}>
        <h2>Algo falló en la interfaz</h2>
        <p className="muted">Tus flujos están guardados en el servidor. Recarga la página para seguir; si se repite, revisa la consola del navegador.</p>
        <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error?.stack || this.state.error)}</pre>
        <button className="primary" onClick={() => location.reload()}>Recargar</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
