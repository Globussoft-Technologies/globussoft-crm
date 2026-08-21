import crypto from 'crypto';
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import singletonPrisma from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/fieldEncryption.js';
import aiManagedApiKeys from '../../lib/aiManagedApiKeys.js';

process.env.WELLNESS_FIELD_KEY = crypto.randomBytes(32).toString('hex');

beforeAll(() => {
  singletonPrisma.aiManagedApiKey = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
});

beforeEach(() => {
  singletonPrisma.aiManagedApiKey.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.aiManagedApiKey.findUnique.mockReset().mockResolvedValue(null);
  singletonPrisma.aiManagedApiKey.create.mockReset().mockImplementation((args) =>
    Promise.resolve({ id: 1, ...args.data, createdAt: new Date(), updatedAt: new Date() }),
  );
  singletonPrisma.aiManagedApiKey.update.mockReset().mockImplementation((args) =>
    Promise.resolve({ id: args.where.id, ...args.data, createdAt: new Date(), updatedAt: new Date() }),
  );
  singletonPrisma.aiManagedApiKey.delete.mockReset().mockResolvedValue({});
});

describe('aiManagedApiKeys — list/formatting', () => {
  test('listKeys masks secrets and fills default base URL', async () => {
    const plainKey = 'sk-abcdef123456';
    singletonPrisma.aiManagedApiKey.findMany.mockResolvedValueOnce([
      { id: 1, providerId: 'openai', label: 'Prod OpenAI', apiKey: encrypt(plainKey), baseUrl: null, isEnabled: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const keys = await aiManagedApiKeys.listKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].apiKey).toContain('...');
    expect(keys[0].baseUrl).toBe('https://api.openai.com/v1');
    expect(keys[0].model).toBe('gpt-4o-mini');
  });

  test('listEnabledKeys only returns enabled rows with secrets', async () => {
    const plainKey = 'gm-key';
    singletonPrisma.aiManagedApiKey.findMany.mockResolvedValueOnce([
      { id: 2, providerId: 'gemini', label: 'Gemini', apiKey: encrypt(plainKey), baseUrl: null, isEnabled: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const keys = await aiManagedApiKeys.listEnabledKeys();
    expect(keys[0].apiKey).toBe(plainKey);
  });
});

describe('aiManagedApiKeys — create', () => {
  test('createKey validates required fields', async () => {
    await expect(aiManagedApiKeys.createKey({})).rejects.toHaveProperty('code', 'INVALID_KEY_INPUT');
  });

  test('createKey stores encrypted key, model, and returns masked value', async () => {
    const result = await aiManagedApiKeys.createKey({ providerId: 'openai', label: 'Test', apiKey: 'sk-test-long-key-12345', model: 'gpt-4o', isEnabled: true });
    const createCall = singletonPrisma.aiManagedApiKey.create.mock.calls[0][0];
    expect(createCall.data.apiKey).toMatch(/^ENC:v1:/);
    expect(decrypt(createCall.data.apiKey)).toBe('sk-test-long-key-12345');
    expect(createCall.data.model).toBe('gpt-4o');
    expect(result.apiKey).toContain('...');
    expect(result.providerId).toBe('openai');
    expect(result.model).toBe('gpt-4o');
  });
});

describe('aiManagedApiKeys — update', () => {
  test('updateKey keeps existing apiKey when body omits it', async () => {
    const existingCipher = encrypt('secret');
    singletonPrisma.aiManagedApiKey.findUnique.mockResolvedValueOnce({
      id: 5, providerId: 'openai', label: 'Old', apiKey: existingCipher, baseUrl: null, isEnabled: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await aiManagedApiKeys.updateKey(5, { label: 'New label' });
    expect(singletonPrisma.aiManagedApiKey.update).toHaveBeenCalled();
    const updateCall = singletonPrisma.aiManagedApiKey.update.mock.calls[0][0];
    expect(updateCall.data.apiKey).toBe(existingCipher);
    expect(updateCall.data.label).toBe('New label');
  });

  test('updateKey replaces apiKey when provided', async () => {
    singletonPrisma.aiManagedApiKey.findUnique.mockResolvedValueOnce({
      id: 6, providerId: 'openai', label: 'Old', apiKey: encrypt('old'), baseUrl: null, model: null, isEnabled: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await aiManagedApiKeys.updateKey(6, { apiKey: 'sk-new' });
    const updateCall = singletonPrisma.aiManagedApiKey.update.mock.calls[0][0];
    expect(updateCall.data.apiKey).toMatch(/^ENC:v1:/);
    expect(decrypt(updateCall.data.apiKey)).toBe('sk-new');
  });

  test('updateKey updates model independently', async () => {
    singletonPrisma.aiManagedApiKey.findUnique.mockResolvedValueOnce({
      id: 8, providerId: 'openai', label: 'Old', apiKey: encrypt('old'), baseUrl: null, model: 'gpt-4o-mini', isEnabled: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await aiManagedApiKeys.updateKey(8, { model: 'gpt-4o' });
    const updateCall = singletonPrisma.aiManagedApiKey.update.mock.calls[0][0];
    expect(updateCall.data.model).toBe('gpt-4o');
  });
});

describe('aiManagedApiKeys — delete', () => {
  test('deleteKey removes row by id', async () => {
    const out = await aiManagedApiKeys.deleteKey(7);
    expect(out.ok).toBe(true);
    expect(singletonPrisma.aiManagedApiKey.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });
});
