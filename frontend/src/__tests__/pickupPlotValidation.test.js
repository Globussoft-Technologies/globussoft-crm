import { describe, expect, it } from 'vitest';
import {
  validateBrokerForm,
  validateLocationForm,
  validatePersonName,
  validatePhoneNumber,
  validatePlotForm,
  validateTransportPersonForm,
} from '../utils/pickupPlotValidation';

describe('pickup and plot form validation', () => {
  it('validates location and plot names, addresses, maps links, and prices', () => {
    expect(validateLocationForm({ name: 'A', address: 'Road', googleMapsLink: '', notes: '' })).toMatch(/at least 2/);
    expect(validateLocationForm({ name: 'North Gate', address: '10 Market Road', googleMapsLink: 'https://example.com/map', notes: '' })).toMatch(/Google Maps/);
    expect(validatePlotForm({
      name: 'Plot A-10', plotNumber: 'A-10', block: 'A', address: '26 Lake Road',
      area: '2', areaUnit: 'KATHA', roadWidth: '30 ft', facing: 'EAST',
      propertyType: 'RESIDENTIAL', price: '350000', availability: 'BOOKED', notes: '',
    })).toBeNull();
    const validPlot = {
      name: 'Plot A-9', plotNumber: 'A-9', block: 'A', address: '25 Lake Road',
      area: '1200', areaUnit: 'SQ_FT', price: '250000', roadWidth: '30 ft',
      propertyType: 'RESIDENTIAL', availability: 'AVAILABLE', notes: '',
    };
    expect(validatePlotForm({ ...validPlot, price: '-1' })).toMatch(/non-negative/);
    expect(validatePlotForm({ ...validPlot, availability: 'HIDDEN' })).toMatch(/valid availability/);

    const requiredFields = [
      ['plotNumber', /Plot number is required/],
      ['block', /Block is required/],
      ['address', /Address is required/],
      ['area', /Area or size is required/],
      ['areaUnit', /Area unit is required/],
      ['price', /Price is required/],
      ['roadWidth', /Road width is required/],
      ['propertyType', /Residential \/ Commercial is required/],
      ['availability', /Availability is required/],
    ];
    requiredFields.forEach(([field, message]) => {
      expect(validatePlotForm({ ...validPlot, [field]: '' })).toMatch(message);
    });
  });

  it('validates transport and broker contact fields', () => {
    expect(validatePersonName('vcgttg334534')).toMatch(/only letters/);
    expect(validatePersonName("D'Souza-Rao")).toBeNull();
    expect(validatePhoneNumber('dfgftg223125')).toMatch(/invalid characters/);
    expect(validateTransportPersonForm({ name: 'Ravi Kumar', phone: '123', alternatePhone: '', vehicleType: '', vehicleNumber: '', serviceArea: '', notes: '' })).toMatch(/7 to 15 digits/);
    expect(validateTransportPersonForm({ name: 'Ravi Kumar', phone: '9000011111', alternatePhone: '', vehicleType: '', vehicleNumber: 'KA 01 AB 1234', serviceArea: '', notes: '' })).toMatch(/Vehicle type is required/);
    expect(validateTransportPersonForm({ name: 'Ravi Kumar', phone: '9000011111', alternatePhone: '', vehicleType: 'Truck', vehicleNumber: '', serviceArea: '', notes: '' })).toMatch(/Vehicle number is required/);
    expect(validateTransportPersonForm({ name: 'Ravi Kumar', phone: '+91 90000 11111', alternatePhone: '', vehicleType: 'Truck', vehicleNumber: 'KA 01 AB 1234', serviceArea: '', notes: '' })).toBeNull();
    expect(validateTransportPersonForm({ name: 'Ravi Kumar', phone: '9000011111', alternatePhone: '', vehicleType: 'Truck', vehicleNumber: 'KA 01 AB 1234', serviceAreas: [{ area: 'Koramangala', state: '', pincode: '560095' }], notes: '' })).toBeNull();
    expect(validateTransportPersonForm({ name: 'Ravi Kumar', phone: '9000011111', alternatePhone: '', vehicleType: 'Truck', vehicleNumber: 'KA 01 AB 1234', serviceAreas: [{ area: '', state: 'Karnataka', pincode: '560095' }], notes: '' })).toMatch(/Area could not be resolved/i);
    expect(validateTransportPersonForm({ name: 'Ravi Kumar', phone: '9000011111', alternatePhone: '', vehicleType: 'Truck', vehicleNumber: 'KA 01 AB 1234', serviceAreas: [{ area: 'Koramangala', state: 'Karnataka', pincode: '560095' }], notes: '' })).toBeNull();
    expect(validateBrokerForm({ name: 'Asha Rao', phone: '9000022222', email: 'wrong@address', agency: '', commissionPercent: '2.5', notes: '' })).toMatch(/valid email/);
    expect(validateBrokerForm({ name: 'Asha Rao', phone: '9000022222', email: 'asha@example.com', agency: '', commissionPercent: '101', notes: '' })).toMatch(/too large/);
  });
});
