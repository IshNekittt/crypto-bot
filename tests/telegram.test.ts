import { TelegramNotifier } from '../src/telegram/notifier';

type FetchMock = jest.Mock<Promise<Pick<Response, 'ok' | 'status' | 'text'>>>;

function okResponse(): Pick<Response, 'ok' | 'status' | 'text'> {
  return { ok: true, status: 200, text: async () => 'ok' };
}

describe('TelegramNotifier', () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is disabled without credentials and never calls fetch', async () => {
    const notifier = new TelegramNotifier(null, null);
    expect(notifier.enabled).toBe(false);
    await expect(notifier.send('test')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends trade closed alert with ❌ for negative PnL', async () => {
    const notifier = new TelegramNotifier('123:ABC', '42');
    fetchSpy.mockResolvedValue(okResponse());

    await expect(notifier.notifyTradeClosed('-12.5')).resolves.toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    expect(String(init.body)).toContain('"chat_id":"42"');
    expect(String(init.body)).toContain('❌ Позиция закрыта. PnL: -12.5 USDT');
  });

  it('sends trade closed alert with ✅ for positive PnL', async () => {
    const notifier = new TelegramNotifier('123:ABC', '42');
    fetchSpy.mockResolvedValue(okResponse());

    await expect(notifier.notifyTradeClosed('7.25')).resolves.toBe(true);
    expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain('✅ Позиция закрыта. PnL: 7.25 USDT');
  });

  it('sends setup found alert in manifest format', async () => {
    const notifier = new TelegramNotifier('123:ABC', '42');
    fetchSpy.mockResolvedValue(okResponse());

    await expect(notifier.notifySetupFound('SOLUSDT', '100.5', '99.9', '103.7')).resolves.toBe(true);
    const body = String(fetchSpy.mock.calls[0]?.[1]?.body);
    expect(body).toContain('👀 Найден сетап по SOLUSDT. Вход: 100.5, SL: 99.9, TP: 103.7');
  });

  it('returns false on HTTP error without throwing', async () => {
    const notifier = new TelegramNotifier('123:ABC', '42');
    fetchSpy.mockResolvedValue({ ok: false, status: 429, text: async () => 'Too Many Requests' });

    await expect(notifier.send('x')).resolves.toBe(false);
  });

  it('returns false when fetch rejects (network failure)', async () => {
    const notifier = new TelegramNotifier('123:ABC', '42');
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));

    await expect(notifier.notifyCriticalError('boom')).resolves.toBe(false);
  });
});
