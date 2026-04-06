/**
 * Tests for relay endpoint authentication.
 *
 * Validates timing-safe token comparison and edge cases.
 */
import crypto from 'crypto';

describe('Relay token authentication', () => {
  // Replicate the timing-safe comparison logic from relay.ts
  function validateRelayToken(authHeader: string | undefined, secret: string): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    const tokenBuf = Buffer.from(token);
    const secretBuf = Buffer.from(secret);
    if (tokenBuf.length !== secretBuf.length) return false;
    return crypto.timingSafeEqual(tokenBuf, secretBuf);
  }

  const SECRET = '0a9670a6557327599f17cd72ef5cf224f5d287798309c5ae95f61ada8068295c';

  test('valid token passes', () => {
    expect(validateRelayToken(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  test('wrong token fails', () => {
    expect(validateRelayToken('Bearer wrong-token-here', SECRET)).toBe(false);
  });

  test('missing header fails', () => {
    expect(validateRelayToken(undefined, SECRET)).toBe(false);
  });

  test('missing Bearer prefix fails', () => {
    expect(validateRelayToken(SECRET, SECRET)).toBe(false);
  });

  test('empty token fails', () => {
    expect(validateRelayToken('Bearer ', SECRET)).toBe(false);
  });

  test('different length token fails without timing leak', () => {
    expect(validateRelayToken('Bearer short', SECRET)).toBe(false);
  });

  test('token with extra whitespace fails', () => {
    expect(validateRelayToken(`Bearer  ${SECRET}`, SECRET)).toBe(false);
  });
});
