import { describe, expect, it } from 'vitest';
import { feedUrl } from './updateFeed';

describe('update feed (review M3)', () => {
  it('derives <server>/download/ from the server URL', () => {
    expect(feedUrl('https://colaba.gptunnel.ai', '')).toBe('https://colaba.gptunnel.ai/download/');
    expect(feedUrl('https://colaba.gptunnel.ai/', '')).toBe('https://colaba.gptunnel.ai/download/');
  });
  it('accepts only https', () => {
    expect(feedUrl('http://localhost:3000', '')).toBeNull();
    expect(feedUrl('', 'http://evil.example/feed')).toBeNull();
    expect(feedUrl('', 'file:///tmp/x')).toBeNull();
    expect(feedUrl('', 'not a url')).toBeNull();
  });
  it('a launch/build-time override wins and gets a trailing slash', () => {
    expect(feedUrl('https://a.example', 'https://updates.example/calaba')).toBe('https://updates.example/calaba/');
  });
  it('no server and no override → off', () => {
    expect(feedUrl('', '')).toBeNull();
  });
});
