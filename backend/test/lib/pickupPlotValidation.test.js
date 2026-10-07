import { describe, expect, test } from 'vitest';
import validation from '../../lib/pickupPlotValidation.js';

const {
  validateEmail,
  validateMoney,
  validateName,
  validatePersonName,
  validatePhone,
  validateVehicleNumber,
} = validation;

describe('pickup and plot validation', () => {
  test('accepts practical person and plot names', () => {
    expect(validateName('Ravi Kumar')).toBeNull();
    expect(validateName("Plot A-9 / North")).toBeNull();
    expect(validateName('A')).toMatch(/at least 2/);
    expect(validateName('<script>')).toMatch(/unsupported/);
    expect(validatePersonName('vcgttg334534')).toMatch(/only letters/);
    expect(validatePersonName("D'Souza-Rao")).toBeNull();
  });

  test('validates local and international phone formats by digit count', () => {
    expect(validatePhone('+91 90000-11111')).toBeNull();
    expect(validatePhone('(080) 1234 5678')).toBeNull();
    expect(validatePhone('123')).toMatch(/7 to 15 digits/);
    expect(validatePhone('90000ABC')).toMatch(/invalid characters/);
  });

  test('validates optional emails, vehicle numbers, and money', () => {
    expect(validateEmail('broker@example.com')).toBeNull();
    expect(validateEmail('broker@invalid')).toMatch(/valid email/);
    expect(validateVehicleNumber('KA 01 AB-1234')).toBeNull();
    expect(validateVehicleNumber('KA@1234')).toMatch(/only letters/);
    expect(validateMoney('250000')).toBeNull();
    expect(validateMoney('-1')).toMatch(/non-negative/);
  });
});
