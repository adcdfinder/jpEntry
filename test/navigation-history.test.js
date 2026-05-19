const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNavigationHistory,
  normalizeNavigationUrl,
} = require('../navigation-history');

test('normalizes only http and https navigation URLs', () => {
  assert.equal(
    normalizeNavigationUrl('http://example.com/root'),
    'http://example.com/root'
  );
  assert.equal(
    normalizeNavigationUrl('https://example.com/path?x=1#top'),
    'https://example.com/path?x=1#top'
  );
  assert.equal(normalizeNavigationUrl('about:blank'), null);
  assert.equal(normalizeNavigationUrl('file:///tmp/page.html'), null);
  assert.equal(normalizeNavigationUrl('not a url'), null);
});

test('records main-window history without duplicate consecutive entries', () => {
  const history = createNavigationHistory();

  history.reset('http://example.com/root');
  history.record('http://example.com/root');
  history.record('http://example.com/page-a');
  history.record('http://example.com/page-a');
  history.record('http://example.com/page-b');

  assert.deepEqual(history.snapshot(), [
    'http://example.com/root',
    'http://example.com/page-a',
    'http://example.com/page-b',
  ]);
});

test('returns previous page and skips the current page when falling back', () => {
  const history = createNavigationHistory();

  history.reset('http://example.com/root');
  history.record('http://example.com/page-a');
  history.record('http://example.com/page-b');

  assert.equal(
    history.previous('http://example.com/page-b'),
    'http://example.com/page-a'
  );
  assert.deepEqual(history.snapshot(), ['http://example.com/root']);
});

test('keeps navigation history within the configured limit', () => {
  const history = createNavigationHistory({ limit: 3 });

  history.reset('http://example.com/0');
  history.record('http://example.com/1');
  history.record('http://example.com/2');
  history.record('http://example.com/3');
  history.record('http://example.com/4');

  assert.deepEqual(history.snapshot(), [
    'http://example.com/2',
    'http://example.com/3',
    'http://example.com/4',
  ]);
});
