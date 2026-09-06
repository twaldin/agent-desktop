import { expect, test } from 'bun:test';
import { browserAddressLabel as label, browserNavigationAddress as navigate } from './browser-address';

test('idle labels preserve local routes and distinguish remote HTTP from HTTPS', () => {
  expect(label('https://www.example.com/path?q=1#part')).toBe('example.com');
  expect(label('http://www.example.com:8080/path')).toBe('http://www.example.com:8080');
  expect(label('http://localhost:3000/path?q=1')).toBe('localhost:3000/path?q=1');
  expect(label('http://127.0.0.1:3000/')).toBe('127.0.0.1:3000');
  expect(label('https://dev.localhost/')).toBe('dev.localhost');
  expect(label('about:blank')).toBe('');
});

test('URL input supports local development, public/private domains, IPs and query text', () => {
  for (const value of ['localhost:3000/path', 'dev.localhost', '[::1]:4000/']) expect(navigate(value)).toBe(`http://${value}`);
  for (const value of ['example.com/path', 'app.github.io', 'www.intranet', 'deckbox:8080', '192.168.1.2', '[2001:db8::1]:8080/']) expect(navigate(value)).toBe(`https://${value}`);
  expect(navigate('  hello world  ')).toBe('https://www.google.com/search?q=hello+world');
  expect(navigate('not-a-domain')).toBe('https://www.google.com/search?q=not-a-domain');
  expect(navigate('999.2.3.4')).toBe('https://www.google.com/search?q=999.2.3.4');
  expect(navigate('https://localhost:4000/')).toBe('https://localhost:4000/');
  expect(navigate('about:blank')).toBe('about:blank');
  expect(navigate('')).toBe('');
});

test('local paths are never sent to a search provider as a fallback', () => {
  for (const value of ['/Users/local/private.txt', 'C:\\private.txt', '\\\\host\\share']) expect(() => navigate(value)).toThrow('host-local');
});
