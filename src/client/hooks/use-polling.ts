import { useEffect, useRef } from 'react';

export function usePolling(callback: () => Promise<void> | void, delay: number | null = 10_000, deps: any[] = []) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    // Initial load
    savedCallback.current();

    if (delay === null) return;

    const id = setInterval(() => {
      savedCallback.current();
    }, delay);

    return () => clearInterval(id);
  }, [delay, ...deps]);
}
