import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageSource, resolveLink } from '../src/media/urls';

test('preview links resolve to the current session and unsafe schemes never open', () => {
  assert.equal(
    resolveLink('preview://open', 'http://10.0.2.2:8002', 's'),
    'http://10.0.2.2:8002/api/agent/sessions/s/preview/',
  );
  assert.equal(
    resolveLink('/api/agent/sessions/s/preview/', 'http://10.0.2.2:8002', 's'),
    'http://10.0.2.2:8002/api/agent/sessions/s/preview/',
  );
  assert.equal(
    resolveLink('javascript:alert(1)', 'http://localhost', 's'),
    null,
  );
  assert.equal(
    resolveLink('file:///private/file', 'http://localhost', 's'),
    null,
  );
});
test('private image requests receive credentials while external images never do', () => {
  assert.deepEqual(
    imageSource(
      '/api/agent/chat-attachments/a/content',
      'http://10.0.2.2:8002',
      'secret',
    ),
    {
      uri: 'http://10.0.2.2:8002/api/agent/chat-attachments/a/content',
      headers: { Authorization: 'Bearer secret' },
    },
  );
  assert.deepEqual(
    imageSource(
      'https://example.com/car.png',
      'http://10.0.2.2:8002',
      'secret',
    ),
    { uri: 'https://example.com/car.png' },
  );
});
