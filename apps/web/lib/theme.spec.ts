import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemeChoice, readThemeChoice, THEME_KEY } from './theme';

const mockSystem = (dark: boolean) =>
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: dark }));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});
afterEach(() => vi.unstubAllGlobals());

describe('theme choice', () => {
  it('stores and applies dark', () => {
    applyThemeChoice('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(readThemeChoice()).toBe('dark');
  });

  it('light overrides a dark system', () => {
    mockSystem(true);
    applyThemeChoice('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('system follows prefers-color-scheme and clears the stored choice', () => {
    mockSystem(true);
    applyThemeChoice('dark');
    applyThemeChoice('system');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement).toHaveClass('dark');
    expect(readThemeChoice()).toBe('system');
  });

  it('survives unavailable storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(readThemeChoice()).toBe('system');
    expect(() => applyThemeChoice('dark')).not.toThrow();
    expect(document.documentElement).toHaveClass('dark');
  });
});
