const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isOtpLoginUrl,
  findOtpInput,
  otpTokenFromSecret,
  normalizeOtpSecret,
  isValidOtpSecret,
} = require('../otp-autofill');

test('matches the configured OTP login page only', () => {
  assert.equal(
    isOtpLoginUrl('http://192.168.88.250:8080/core/auth/login/otp/'),
    true
  );
  assert.equal(
    isOtpLoginUrl('http://192.168.88.250:8080/core/auth/login/otp'),
    true
  );
  assert.equal(
    isOtpLoginUrl('http://192.168.88.250:8080/core/auth/login/password/'),
    false
  );
  assert.equal(
    isOtpLoginUrl('https://192.168.88.250:8080/core/auth/login/otp/'),
    false
  );
});

test('finds an OTP code input by common form hints', () => {
  const inputs = [
    { type: 'text', name: 'username', id: 'username', autocomplete: 'username' },
    { type: 'text', name: 'otpCode', id: 'otp-code', placeholder: 'OTP Code' },
    { type: 'password', name: 'password', id: 'password' },
  ];

  assert.equal(findOtpInput(inputs), inputs[1]);
});

test('falls back to a six digit numeric text input', () => {
  const inputs = [
    { type: 'text', name: 'username', value: 'admin' },
    { type: 'text', maxlength: '6', inputmode: 'numeric' },
  ];

  assert.equal(findOtpInput(inputs), inputs[1]);
});

test('generates a six digit OTP token from a stored secret', () => {
  const authenticator = {
    generate(secret) {
      assert.equal(secret, 'JBSWY3DPEHPK3PXP');
      return '123456';
    },
  };

  assert.equal(otpTokenFromSecret(authenticator, 'jbsw y3dp ehpk 3pxp'), '123456');
});

test('normalizes OTP secrets for storage and token generation', () => {
  assert.equal(normalizeOtpSecret('abcd efgh\nijkl'), 'ABCDEFGHIJKL');
});

test('validates Base32 OTP secrets before generating tokens', () => {
  assert.equal(isValidOtpSecret('JBSWY3DPEHPK3PXP'), true);
  assert.equal(isValidOtpSecret('ABC'), false);
  assert.equal(isValidOtpSecret('INVALID!!!INVALID'), false);
  assert.equal(otpTokenFromSecret({ generate: () => '123456' }, 'ABC'), null);
});
