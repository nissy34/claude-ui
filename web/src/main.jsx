import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './design/tokens.css';
import './design/components.css';
import './styles.css';
import './theme.js';
import './prefs.js';
import App from './App.jsx';

// /#design shows the design system reference (tokens and shared components).
const Gallery = React.lazy(() => import('./design/Gallery.jsx'));
function Root() {
  const [design, setDesign] = React.useState(() => location.hash === '#design');
  React.useEffect(() => {
    const on = () => setDesign(location.hash === '#design');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return design ? (
    <React.Suspense fallback={null}>
      <Gallery />
    </React.Suspense>
  ) : (
    <App />
  );
}

createRoot(document.getElementById('root')).render(<Root />);

// Keep the layout above the on-screen keyboard on phones.
function syncHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${h}px`);
}
syncHeight();
window.visualViewport?.addEventListener('resize', syncHeight);
window.addEventListener('resize', syncHeight);
