import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);

// Keep the layout above the on-screen keyboard on phones.
function syncHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${h}px`);
}
syncHeight();
window.visualViewport?.addEventListener('resize', syncHeight);
window.addEventListener('resize', syncHeight);
