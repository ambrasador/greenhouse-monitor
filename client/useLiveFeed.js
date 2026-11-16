import { useEffect, useState } from 'react';
import { createLiveFeed } from './livefeed.js';

// Хук: життєвий цикл потоку прив’язано до компонента. Cleanup обов’язковий:
// без нього кожне повторне монтування (React StrictMode монтує двічі)
// залишало б відкрите з’єднання
export function useLiveFeed(make, deps) {
  const [view, setView] = useState(
    { status: 'connecting', attempt: 0, series: {}, dataAt: null });
  useEffect(() => {
    const feed = createLiveFeed({ ...make(), onView: setView });
    feed.start();
    return () => feed.stop();
  }, deps);
  return view;
}
