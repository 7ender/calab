import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { log } from './lib/log';
import { bootstrap } from './services/session';
import './app/styles.css';

window.addEventListener('error', (e) => log.error('uncaught', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => log.error('unhandled rejection', e.reason));

void bootstrap();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
