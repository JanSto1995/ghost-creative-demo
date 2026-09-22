'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { decisionReplySchema, snapshotSchema, type Decision, type Snapshot } from '@/lib/contracts';
import type { Copy } from '@/lib/copy';

type Attempt = Decision & { key: string };
async function fetchSnapshot(signal: AbortSignal) {
  const response = await fetch('/api/decisions', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Load failed');
  return {
    snapshot: snapshotSchema.parse(await response.json()),
    freshSession: response.headers.get('X-Demo-Session') === 'new',
  };
}
export function ReviewQueue({ text: t }: { text: Copy }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [uncertain, setUncertain] = useState<Attempt | null>(null);
  const [message, setMessage] = useState('');
  const [resetting, setResetting] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const busy = useRef(false);
  const activeLoad = useRef<AbortController | null>(null);
  const cancelLoad = useCallback(() => {
    activeLoad.current?.abort();
    activeLoad.current = null;
  }, []);
  const load = useCallback(() => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    return fetchSnapshot(AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
      .then((result) => {
        if (activeLoad.current !== controller) return false;
        setSnapshot((current) =>
          !current || result.freshSession || result.snapshot.revision >= current.revision
            ? result.snapshot
            : current,
        );
        setLoadFailed(false);
        return true;
      })
      .catch(() => {
        if (activeLoad.current === controller && !controller.signal.aborted) setLoadFailed(true);
        return false;
      })
      .finally(() => {
        if (activeLoad.current === controller) activeLoad.current = null;
      });
  }, []);
  useEffect(() => {
    void load();
    return cancelLoad;
  }, [load, cancelLoad]);
  async function reset() {
    if (busy.current) return;
    busy.current = true;
    cancelLoad();
    setResetting(true);
    setMessage('');
    try {
      const response = await fetch('/api/decisions/reset', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Reset failed');
      const result = snapshotSchema.parse(await response.json());
      setSnapshot((current) =>
        !current || result.revision >= current.revision ? result : current,
      );
      setUncertain(null);
      setMessage(t.resetDone);
    } catch {
      // A lost reset response is ambiguous too. Reconcile without repeating the reset.
      if (await load()) setUncertain(null);
      setMessage(t.resetError);
    } finally {
      busy.current = false;
      setResetting(false);
    }
  }
  async function decide(attempt: Attempt) {
    if (busy.current || !snapshot) return;
    busy.current = true;
    cancelLoad();
    setPending(attempt);
    setMessage('');
    try {
      const response = await fetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
        body: JSON.stringify({ id: attempt.id, action: attempt.action }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        // Another tab or a reset may have changed this session; reconcile authoritative state.
        if (response.status === 409 || response.status === 404) {
          if (await load()) {
            setUncertain(null);
            setMessage(t.conflict);
            return;
          }
        } else setUncertain(attempt);
        throw new Error('Decision failed');
      }
      const result = decisionReplySchema.parse(await response.json());
      setSnapshot((current) =>
        !current || result.snapshot.revision >= current.revision ? result.snapshot : current,
      );
      setUncertain(null);
      setMessage(t.saved);
    } catch {
      // Keep the key after a timeout: the server may already have committed.
      setUncertain((current) => current ?? attempt);
      setMessage(t.error);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }
  if (!snapshot)
    return (
      <div className="queue-loading" role="status">
        {loadFailed ? t.loadError : t.loading}
        {loadFailed && (
          <button className="button secondary" onClick={() => void load()}>
            {t.retry}
          </button>
        )}
      </div>
    );
  const displayed = snapshot.items.map((item) =>
    item.id === pending?.id
      ? {
          ...item,
          status: pending.action === 'approve' ? ('approved' as const) : ('rejected' as const),
        }
      : item,
  );
  const balance =
    snapshot.balance -
    (pending?.action === 'approve' &&
    snapshot.items.some((item) => item.id === pending.id && item.status === 'pending')
      ? 1
      : 0);
  return (
    <section aria-label={t.reviewEyebrow}>
      <div className="queue-toolbar">
        <button
          className="button secondary"
          disabled={!!pending || resetting}
          onClick={() => void reset()}
        >
          {resetting ? t.resetting : t.reset}
        </button>
        <span>
          {snapshot.items.length} {t.count}
        </span>
        <span className="credit-badge">
          {t.credits}
          <strong>{balance}</strong>
        </span>
      </div>
      <div className="queue-grid">
        {displayed.map((item, index) => (
          <article key={item.id} className="creative-card" aria-busy={pending?.id === item.id}>
            <div className={`creative-art art-${item.palette}`} lang="en">
              <div className="art-top">
                <span>STUDIO / 00{index + 1}</span>
                <span aria-hidden="true">✳</span>
              </div>
              <div className="mini-sculpture" aria-hidden="true" />
              <h2>{item.hook}</h2>
              <p>{item.caption}</p>
            </div>
            <div className="creative-details">
              <span className={`status status-${item.status}`}>
                {pending?.id === item.id ? t.saving : t[item.status]}
              </span>
              <span className="format-label">{item.format === 'square' ? '1:1' : '4:5'}</span>
            </div>
            <div className="decision-actions">
              <button
                className="button secondary"
                disabled={item.status !== 'pending' || !!pending || !!uncertain || resetting}
                onClick={() =>
                  void decide({ id: item.id, action: 'reject', key: crypto.randomUUID() })
                }
              >
                {t.reject}
              </button>
              <button
                className="button primary"
                disabled={item.status !== 'pending' || !!pending || !!uncertain || resetting}
                onClick={() =>
                  void decide({ id: item.id, action: 'approve', key: crypto.randomUUID() })
                }
              >
                {t.approve}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </article>
        ))}
      </div>
      <div
        className={`queue-feedback${message ? ' has-message' : ''}`}
        role="status"
        aria-live="polite"
      >
        <p>{message}</p>
        {uncertain && (
          <button
            className="button secondary"
            disabled={!!pending || resetting}
            onClick={() => void decide(uncertain)}
          >
            {t.retry}
          </button>
        )}
      </div>
    </section>
  );
}
