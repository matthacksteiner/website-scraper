import picomatch from 'picomatch';
import { ScopeMode } from './types';

export const isHttpUrl = (value: string): boolean => {
  return value.startsWith('http://') || value.startsWith('https://');
};

export const normalizeUrl = (value: string): string => {
  const url = new URL(value);
  url.hash = '';
  if (!url.pathname) {
    url.pathname = '/';
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
};

export const toDisplayUrl = (value: string): string => {
  try {
    return normalizeUrl(value);
  } catch {
    return value;
  }
};

export const createScopeFilter = (
  baseUrl: string,
  mode: ScopeMode,
  include: string[],
  exclude: string[],
) => {
  const base = new URL(baseUrl);
  const includeMatchers = include.map((pattern) => picomatch(pattern));
  const excludeMatchers = exclude.map((pattern) => picomatch(pattern));

  return (candidate: string): boolean => {
    if (!isHttpUrl(candidate)) {
      return false;
    }

    const url = new URL(candidate);

    if (mode === 'same-origin') {
      if (url.origin !== base.origin) {
        return false;
      }
    }

    if (mode === 'subdomains') {
      if (url.hostname === base.hostname) {
        // ok
      } else if (!url.hostname.endsWith(`.${base.hostname}`)) {
        return false;
      }
    }

    if (mode === 'custom') {
      const includeOk =
        includeMatchers.length === 0 || includeMatchers.some((match) => match(candidate));
      const excludeOk = !excludeMatchers.some((match) => match(candidate));
      if (!includeOk || !excludeOk) {
        return false;
      }
    }

    return true;
  };
};
