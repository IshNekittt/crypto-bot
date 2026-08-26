import { Decimal } from 'decimal.js';
import { formatPrice, formatQuantity, roundDownToStep } from '../src/utils/precision';

describe('Bybit Precision Formatter', () => {
  describe('roundDownToStep', () => {
    it('rounds qty down to qtyStep multiples', () => {
      expect(roundDownToStep(new Decimal('12.34'), new Decimal('0.1')).toFixed(1)).toBe('12.3');
      expect(roundDownToStep(new Decimal('12.39'), new Decimal('0.1')).toFixed(1)).toBe('12.3');
    });

    it('never rounds up', () => {
      expect(roundDownToStep(new Decimal('0.299999999'), new Decimal('0.1')).toFixed(10)).toBe('0.2000000000');
    });

    it('handles integer steps', () => {
      expect(roundDownToStep(new Decimal('7.9'), new Decimal('1')).toFixed(0)).toBe('7');
    });

    it('returns 0 when value is smaller than step', () => {
      expect(roundDownToStep(new Decimal('0.04'), new Decimal('0.1')).toNumber()).toBe(0);
    });

    it('keeps values already on step unchanged', () => {
      expect(roundDownToStep(new Decimal('96.86'), new Decimal('0.01')).toFixed(2)).toBe('96.86');
    });

    it('throws on zero or negative step', () => {
      expect(() => roundDownToStep(new Decimal(1), new Decimal(0))).toThrow(/Invalid precision step/);
      expect(() => roundDownToStep(new Decimal(1), new Decimal('-0.1'))).toThrow(/Invalid precision step/);
    });
  });

  describe('formatQuantity', () => {
    it('produces exchange-ready string for real Bybit filters', () => {
      expect(formatQuantity(new Decimal('2.478123'), new Decimal('0.1'))).toBe('2.4');
      expect(formatQuantity(new Decimal('0.00356'), new Decimal('0.001'))).toBe('0.003');
      expect(formatQuantity(new Decimal('1500'), new Decimal('1'))).toBe('1500');
    });
  });

  describe('formatPrice', () => {
    it('rounds prices down to tickSize multiples', () => {
      expect(formatPrice(new Decimal('99.99999'), new Decimal('0.01'))).toBe('99.99');
      expect(formatPrice(new Decimal('100'), new Decimal('0.01'))).toBe('100');
      expect(formatPrice(new Decimal('65000.125'), new Decimal('0.1'))).toBe('65000.1');
    });
  });
});
