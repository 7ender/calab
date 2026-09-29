import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion } from './version';

describe('compareVersions', () => {
  it('orders release versions numerically', () => {
    expect(compareVersions('0.9.1', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('v0.9.0', '0.9.0')).toBe(0);
  });
  it('a prerelease sorts before its release', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });
  it('non-versions compare as null', () => {
    expect(compareVersions('dev', '0.9.0')).toBeNull();
    expect(compareVersions('0.9.0', '')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('strictly newer only; never for a non-version', () => {
    expect(isNewerVersion('0.9.1', '0.9.0')).toBe(true);
    expect(isNewerVersion('0.9.0', '0.9.0')).toBe(false);
    expect(isNewerVersion('0.7.0', '0.9.0')).toBe(false);
    expect(isNewerVersion('dev', '0.9.0')).toBe(false);
    expect(isNewerVersion('0.9.1', 'unknown')).toBe(false);
  });
});
