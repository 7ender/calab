import { describe, expect, it } from 'vitest';
import { isLoopbackHost, serverUrlProblem } from './serverUrl';

describe('serverUrlProblem (review L11)', () => {
  it('accepts https anywhere', () => {
    expect(serverUrlProblem('https://app.example.com')).toBeNull();
    expect(serverUrlProblem(' https://10.0.0.5:8443/ ')).toBeNull();
  });
  it('accepts plain http only on loopback', () => {
    expect(serverUrlProblem('http://localhost:3900')).toBeNull();
    expect(serverUrlProblem('http://127.0.0.1:8080')).toBeNull();
    expect(serverUrlProblem('http://[::1]:8080')).toBeNull();
    expect(serverUrlProblem('http://app.example.com')).toBe('insecure');
    expect(serverUrlProblem('http://192.168.1.10')).toBe('insecure');
    expect(serverUrlProblem('http://127.0.0.1.evil.com')).toBe('insecure');
    expect(serverUrlProblem('http://localhost.evil.com')).toBe('insecure');
  });
  it('honours the explicit escape hatch', () => {
    expect(serverUrlProblem('http://192.168.1.10', true)).toBeNull();
  });
  it('rejects garbage and other schemes', () => {
    expect(serverUrlProblem('app.example.com')).toBe('invalid');
    expect(serverUrlProblem('ftp://x')).toBe('invalid');
    expect(serverUrlProblem('file:///etc/passwd')).toBe('invalid');
  });
  it('loopback host detection', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
  });
});
