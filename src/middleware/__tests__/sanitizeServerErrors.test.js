'use strict';

jest.mock('@opentelemetry/api', () => ({ trace: { getActiveSpan: () => null } }));

const { sanitizeServerErrors } = require('../sanitizeServerErrors');

function run(statusCode, body) {
  const sent = {};
  const res = {
    statusCode,
    json(b) { sent.body = b; return this; },
  };
  const req = { path: '/api/v1/bulk/quotes', log: { error: jest.fn() } };
  sanitizeServerErrors(req, res, () => {});
  res.json(body);
  return { sent: sent.body, log: req.log };
}

const FIRESTORE_LEAK =
  '9 FAILED_PRECONDITION: The query requires an index. You can create it here: ' +
  'https://console.firebase.google.com/v1/r/project/suppliable-dev/firestore/indexes?create_composite=ClFw';

describe('sanitizeServerErrors', () => {
  test('replaces a leaking 500 message and adds a correlationId', () => {
    const { sent } = run(500, { success: false, error: 'SERVER_ERROR', message: FIRESTORE_LEAK });
    expect(sent.message).toContain('Something went wrong. Please try again.');
    expect(sent.message).toContain(`(ref: ${sent.correlationId})`);
    expect(sent.message).not.toContain('console.firebase.google.com');
    expect(sent.message).not.toContain('suppliable-dev');
    expect(sent.message).not.toContain('FAILED_PRECONDITION');
    expect(sent.correlationId).toMatch(/^[0-9a-f]{8}$/);
    expect(sent.success).toBe(false);
  });

  test('logs the withheld text server-side with the same correlationId', () => {
    const { sent, log } = run(500, { success: false, message: FIRESTORE_LEAK });
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields] = log.error.mock.calls[0];
    expect(fields.rawMessage).toBe(FIRESTORE_LEAK);
    expect(fields.correlationId).toBe(sent.correlationId);
  });

  test('leaves 4xx messages alone — that copy is written to be read', () => {
    const { sent } = run(400, { success: false, error: 'INVALID_PARAM', message: 'pincode is required' });
    expect(sent.message).toBe('pincode is required');
    expect(sent.correlationId).toBeUndefined();
  });

  test('leaves 2xx bodies untouched', () => {
    const { sent } = run(200, { success: true, data: { foo: 1 } });
    expect(sent).toEqual({ success: true, data: { foo: 1 } });
  });

  test('preserves extra fields a handler set alongside the message', () => {
    const { sent } = run(500, { success: false, message: 'boom', issues: ['a'], canAddToCart: true });
    expect(sent.issues).toEqual(['a']);
    expect(sent.canAddToCart).toBe(true);
    expect(sent.message).toContain('Something went wrong. Please try again.');
  });

  test('does not mint a second correlationId over an already-sanitised body', () => {
    const { sent, log } = run(500, { success: false, error: 'SERVER_ERROR', message: 'generic', correlationId: 'abc12345' });
    expect(sent.correlationId).toBe('abc12345');
    expect(log.error).not.toHaveBeenCalled();
  });

  test('503 and other 5xx are covered, not just 500', () => {
    const { sent } = run(503, { success: false, message: 'upstream exploded at /srv/app/x.js:42' });
    expect(sent.message).toContain('Something went wrong. Please try again.');
    expect(sent.message).not.toContain('/srv/app');
  });
});
