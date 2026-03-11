import { useState, useEffect } from 'react';

const MQ = '(max-width: 480px)';

export function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia(MQ).matches);
  useEffect(() => {
    const mql = window.matchMedia(MQ);
    const handler = (e: MediaQueryListEvent) => setM(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return m;
}
