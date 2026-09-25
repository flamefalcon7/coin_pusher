import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import MaintenancePage from './pages/MaintenancePage';

// Servers are shut down; flip to false to bring the game back.
// App is lazy-loaded so maintenance mode never downloads the game bundle.
const MAINTENANCE_MODE = true;

const App = lazy(() => import('./App'));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {MAINTENANCE_MODE ? (
      <MaintenancePage />
    ) : (
      <BrowserRouter>
        <Suspense fallback={null}>
          <App />
        </Suspense>
      </BrowserRouter>
    )}
  </React.StrictMode>
);
