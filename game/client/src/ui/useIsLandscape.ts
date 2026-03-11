import { useState, useEffect } from 'react';

const MQ = '(max-height: 480px) and (orientation: landscape)';

export function useIsLandscape(): boolean {
  const [l, setL] = useState(() => window.matchMedia(MQ).matches);
  useEffect(() => {
    const mql = window.matchMedia(MQ);
    const handler = (e: MediaQueryListEvent) => setL(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return l;
}
