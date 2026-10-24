import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './use-polling';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});
afterEach(() => vi.useRealTimers());

describe('usePolling', () => {
  it('fetches on mount', async () => {
    const fn = vi.fn().mockResolvedValue('a');
    const { result } = renderHook(() => usePolling(fn, 1000));
    expect(result.current.loading).toBe(true);
    await act(async () => {});
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ data: 'a', error: null, loading: false });
  });

  it('refetches on the interval', async () => {
    const fn = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    const { result } = renderHook(() => usePolling(fn, 1000));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('b');
  });

  it('pauses while the tab is hidden and refetches when it is visible again', async () => {
    const fn = vi.fn().mockResolvedValue('a');
    renderHook(() => usePolling(fn, 1000));
    await act(async () => {});
    act(() => setHidden(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => setHidden(false));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ignores a response from a stale request', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fn = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => usePolling(fn, 60_000));
    act(() => {
      void result.current.refresh();
    });
    await act(async () => second.resolve('new'));
    expect(result.current.data).toBe('new');
    await act(async () => first.resolve('old'));
    expect(result.current.data).toBe('new');
  });

  it('exposes errors and keeps the last data', async () => {
    const fn = vi.fn().mockResolvedValueOnce('a').mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => usePolling(fn, 1000));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.data).toBe('a');
    expect(result.current.error?.message).toBe('boom');
  });
});
