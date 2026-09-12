import { useEffect, useState } from 'react';
import { Button } from './ui.tsx';

export function TraceFrame({ url, back }: { url: string; back: string }) {
  const [status, setStatus] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (status !== 'loading') return;
    const timer = setTimeout(() => setStatus('error'), 90_000);
    return () => clearTimeout(timer);
  }, [status, attempt]);
  if (!/^\/atif_view\/[a-f0-9]{64}\/\?/.test(url)) return <p>Invalid trace link.</p>;
  return (
    <section className="fixed inset-0 flex flex-col bg-white">
      <a href={back} className="min-h-11 border-b p-3 underline">
        Back to simulation
      </a>
      {status === 'loading' && (
        <p role="status" className="p-4">
          <span
            aria-hidden="true"
            className="mr-2 inline-block size-4 animate-spin rounded-full border-2 border-t-transparent motion-reduce:animate-none"
          />
          Loading trajectory…
        </p>
      )}
      {status === 'error' && (
        <div role="alert" className="p-4">
          Viewer unavailable.{' '}
          <Button
            onClick={() => {
              setStatus('loading');
              setAttempt(attempt + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <iframe
        key={attempt}
        title="Harbor player trajectory"
        src={url}
        className={`min-h-0 flex-1 border-0 ${status !== 'ready' ? 'invisible' : ''}`}
        onLoad={(event) => {
          const frame = event.currentTarget;
          try {
            if (
              !frame.contentWindow?.location.pathname.startsWith('/jobs/') ||
              !frame.contentDocument?.querySelector('script[type="module"]')
            )
              throw new Error();
            const style = frame.contentDocument!.createElement('style');
            style.textContent =
              'div.flex.h-12.items-center.justify-between.px-4:has(a[href="/run"]), nav[aria-label="breadcrumb"]:has(a[title="Jobs"][href="/"]) { display: none !important; }';
            frame.contentDocument!.head.append(style);
            setStatus('ready');
          } catch {
            setStatus('error');
          }
        }}
      />
    </section>
  );
}
