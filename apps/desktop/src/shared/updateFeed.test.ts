import { describe, expect, it } from 'vitest';
import { feedUrl } from './updateFeed';

describe('update feed (review M3)', () => {
  it('app.X → https://releases.X/', () => {
    expect(feedUrl('https://app.calab.ru', '')).toBe('https://releases.calab.ru/');
    expect(feedUrl('https://app.calab.ru/', '')).toBe('https://releases.calab.ru/');
    expect(feedUrl('https://app.calab.ru///', '')).toBe('https://releases.calab.ru/');
  });
  it('nested app.a.b → releases.a.b', () => {
    expect(feedUrl('https://app.team.example.com', '')).toBe('https://releases.team.example.com/');
  });
  it('keeps the port', () => {
    expect(feedUrl('https://app.example.com:8443', '')).toBe('https://releases.example.com:8443/');
    expect(feedUrl('https://chat.example.com:8443/', '')).toBe('https://chat.example.com:8443/download/');
  });
  it('any other host → <server>/download/', () => {
    expect(feedUrl('https://colaba.gptunnel.ai', '')).toBe('https://colaba.gptunnel.ai/download/');
    expect(feedUrl('https://colaba.gptunnel.ai/', '')).toBe('https://colaba.gptunnel.ai/download/');
    // «app» only as the first label counts; «myapp.x» / «x.app.y» are other hosts.
    expect(feedUrl('https://myapp.example.com', '')).toBe('https://myapp.example.com/download/');
    expect(feedUrl('https://x.app.example.com', '')).toBe('https://x.app.example.com/download/');
  });
  it('accepts only https', () => {
    expect(feedUrl('http://localhost:3000', '')).toBeNull();
    expect(feedUrl('http://app.example.com', '')).toBeNull();
    expect(feedUrl('', 'http://evil.example/feed')).toBeNull();
    expect(feedUrl('', 'file:///tmp/x')).toBeNull();
    expect(feedUrl('', 'not a url')).toBeNull();
    expect(feedUrl('not a url', '')).toBeNull();
  });
  it('a launch/build-time override wins and gets a trailing slash', () => {
    expect(feedUrl('https://a.example', 'https://updates.example/calaba')).toBe('https://updates.example/calaba/');
    expect(feedUrl('https://app.calab.ru', 'https://updates.example/')).toBe('https://updates.example/');
    // A non-https override does not fall back to the derived feed.
    expect(feedUrl('https://app.calab.ru', 'http://updates.example/')).toBeNull();
  });
  it('no server and no override → off', () => {
    expect(feedUrl('', '')).toBeNull();
    expect(feedUrl('', '  ')).toBeNull();
  });
});
