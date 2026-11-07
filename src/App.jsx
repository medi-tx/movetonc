import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { ToastProvider } from './components/Toast.jsx';
import { SetupScreen } from './screens/SetupScreen.jsx';
import { AuthScreen } from './screens/AuthScreen.jsx';
import { ChatApp } from './screens/ChatApp.jsx';

function Splash({ error, onRetry }) {
  return (
    <div className="splash">
      <div className="splash-logo" aria-hidden="true">
        🌈
      </div>
      <h1>DisKids</h1>
      {error ? (
        <>
          <p className="splash-error">{error}</p>
          <button type="button" className="button button-primary" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : (
        <>
          <p>Opening the clubhouse…</p>
          <span className="splash-spinner" aria-label="Loading" />
        </>
      )}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!state) return <Splash error={error} onRetry={load} />;

  return (
    <ToastProvider>
      {!state.setupComplete ? (
        <SetupScreen clubName={state.clubName} onDone={load} />
      ) : !state.user ? (
        <AuthScreen clubName={state.clubName} onDone={load} />
      ) : (
        <ChatApp state={state} onState={setState} onLoggedOut={load} />
      )}
    </ToastProvider>
  );
}
