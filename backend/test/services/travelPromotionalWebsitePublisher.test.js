import { describe, expect, test, vi } from 'vitest';
import publisher from '../../services/travelPromotionalWebsitePublisher.js';

const {
  normalizeRemotePath,
  normalizeProtocol,
  getDefaultPort,
  ftpConnectionOptions,
  getRemoteTripDirectory,
  getRemoteTripFile,
  getPublicTripUrl,
  renderHostedLandingPage,
  publishLandingPage,
  removeLandingPage,
  removeRemoteDirectory,
} = publisher;

describe('travel promotional website publisher', () => {
  test('normalizes safe remote paths and rejects traversal', () => {
    expect(normalizeRemotePath('trips/')).toBe('/');
    expect(normalizeRemotePath('/home/modernclassroom/public_html/main-forms/trips')).toBe('/home/modernclassroom/public_html/main-forms');
    expect(normalizeRemotePath('/')).toBe('/');
    expect(getRemoteTripDirectory('/', 27)).toBe('/27');
    expect(getRemoteTripFile('/', 27)).toBe('/27/index.html');
    expect(() => normalizeRemotePath('/var/www/../private')).toThrow(/safe directory/i);
  });

  test('normalizes supported transfer protocols and their default ports', () => {
    expect(normalizeProtocol('FTP')).toBe('ftp');
    expect(normalizeProtocol('ftps')).toBe('ftps');
    expect(normalizeProtocol()).toBe('sftp');
    expect(getDefaultPort('ftp')).toBe(21);
    expect(getDefaultPort('ftps')).toBe(21);
    expect(getDefaultPort('sftp')).toBe(22);
    expect(ftpConnectionOptions({ protocol: 'ftps', host: 'secure.example.com', username: 'deploy', password: 'secret' })).toMatchObject({
      host: 'secure.example.com', user: 'deploy', password: 'secret', port: 21, secure: true,
    });
    expect(ftpConnectionOptions({ protocol: 'ftps', host: 'secure.example.com', port: 990, username: 'deploy', password: 'secret' }).secure).toBe('implicit');
  });

  test('builds the client trip URL from the landing page number', () => {
    expect(getPublicTripUrl('https://client.example.com', 27)).toBe('https://client.example.com/trips/27');
  });

  test('renders a CRM-backed availability gate and absolute CRM endpoints', () => {
    const html = renderHostedLandingPage({ id: 27, title: 'Test trip', slug: 'test-trip', content: '[]' }, {
      crmBaseUrl: 'https://crm.example.com',
    });
    expect(html).toContain('crm-trip-availability-style');
    expect(html).toContain('https://crm.example.com/api/landing-pages/public/status/27');
    expect(html).toContain('https://crm.example.com/api/pages/test-trip/track');
    expect(html).not.toContain('src="/api/pages/test-trip/track');
  });

  test('creates only the numeric trip folder and index file inside the configured root over SFTP', async () => {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      mkdir: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const result = await publishLandingPage({
      page: { id: 27, title: 'Test trip', slug: 'test-trip', content: '[]', isFeatured: true },
      sftp: { host: 'sftp.example.com', username: 'deploy', password: 'secret' },
      remotePath: '/',
      websiteUrl: 'https://client.example.com',
      crmBaseUrl: 'https://crm.example.com',
      clientFactory: () => client,
    });

    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'sftp.example.com', username: 'deploy', port: 22 }));
    expect(client.list).toHaveBeenCalledWith('/');
    expect(client.mkdir).toHaveBeenCalledWith('/27', false);
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(client.put.mock.calls.map((call) => call[1])).toEqual(['/27/index.html']);
    expect(result.publicUrl).toBe('https://client.example.com/trips/27');
  });

  test('removes only the trip folder when deleting a page', async () => {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      rmdir: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    };
    await removeLandingPage({
      pageId: 27,
      sftp: { host: 'sftp.example.com', username: 'deploy', privateKey: 'key' },
      remotePath: '/',
      clientFactory: () => client,
    });
    expect(client.rmdir).toHaveBeenCalledWith('/27', true);
  });

  test('publishes through plain FTP with the configured FTP credentials', async () => {
    const client = {
      access: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      ensureDir: vi.fn().mockResolvedValue(undefined),
      uploadFrom: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    const result = await publishLandingPage({
      page: { id: 28, title: 'FTP trip', slug: 'ftp-trip', content: '[]' },
      sftp: { protocol: 'ftp', host: 'ftp.example.com', port: 21, username: 'deploy', password: 'secret' },
      remotePath: '/home/modernclassroom/public_html/main-forms',
      websiteUrl: 'https://client.example.com',
      crmBaseUrl: 'https://crm.example.com',
      ftpClientFactory: () => client,
    });

    expect(client.access).toHaveBeenCalledWith({
      host: 'ftp.example.com', port: 21, user: 'deploy', password: 'secret', secure: false,
    });
    expect(client.list).toHaveBeenCalledWith();
    expect(client.ensureDir).toHaveBeenCalledWith('28');
    expect(client.uploadFrom).toHaveBeenCalledWith(expect.anything(), 'index.html');
    expect(result.remoteFile).toBe('28/index.html');
    expect(client.close).toHaveBeenCalled();
  });

  test('removes only the numeric folder from the FTP account root', async () => {
    const client = {
      access: vi.fn().mockResolvedValue(undefined),
      removeDir: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    const result = await removeLandingPage({
      pageId: 28,
      sftp: { protocol: 'ftp', host: 'ftp.example.com', username: 'deploy', password: 'secret' },
      remotePath: '/home/modernclassroom/public_html/main-forms',
      ftpClientFactory: () => client,
    });

    expect(client.removeDir).toHaveBeenCalledWith('28');
    expect(result.remoteFile).toBe('28/index.html');
  });

  test('treats an already-missing remote folder as an idempotent delete', async () => {
    const client = { rmdir: vi.fn().mockRejectedValue(new Error('No such file')) };
    await expect(removeRemoteDirectory(client, '/trips/27')).resolves.toBeUndefined();
  });
});
