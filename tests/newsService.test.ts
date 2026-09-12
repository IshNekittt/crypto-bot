import { NewsService } from '../src/services/newsService';

describe('NewsService', () => {
  let newsService: NewsService;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    newsService = new NewsService();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('fetchNews', () => {
it('should filter and store only high-impact confirmed USD events', async () => {
      const mockEvents = [
        { release: 'nfp', name: 'Non-Farm Payrolls', announcement_datetime: Math.floor((Date.now() + 3600000) / 1000), announcement_datetime_utc: new Date(Date.now() + 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1, source: 'BLS' },
        { release: 'fomc', name: 'FOMC Minutes', announcement_datetime: Math.floor((Date.now() + 7200000) / 1000), announcement_datetime_utc: new Date(Date.now() + 7200000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1, source: 'FRB' },
        { release: 'cpi', name: 'CPI', announcement_datetime: Math.floor((Date.now() + 10800000) / 1000), announcement_datetime_utc: new Date(Date.now() + 10800000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1, source: 'BLS' },
        { release: 'claims', name: 'Unemployment Claims', announcement_datetime: Math.floor((Date.now() + 10800000) / 1000), announcement_datetime_utc: new Date(Date.now() + 10800000).toISOString(), release_date_confirmed: true, event_importance: 'medium', market_tier: 2, source: 'BLS' },
        { release: 'claims2', name: 'Unemployment Claims 2', announcement_datetime: Math.floor((Date.now() + 14400000) / 1000), announcement_datetime_utc: new Date(Date.now() + 14400000).toISOString(), release_date_confirmed: true, event_importance: 'low', market_tier: 3, source: 'BLS' },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(3);
      expect(news[0].name).toBe('Non-Farm Payrolls');
      expect(news[1].name).toBe('FOMC Minutes');
      expect(news.every(n => n.name !== 'Unemployment Claims')).toBe(true);
    });

    it('should sort events by timestamp ascending', async () => {
      const now = Date.now();
      const laterDate = new Date(now + 7200000).toISOString();
      const earlierDate = new Date(now + 3600000).toISOString();

      const mockEvents = [
        { release: 'later', name: 'Later Event', announcement_datetime: Math.floor((now + 7200000) / 1000), announcement_datetime_utc: laterDate, release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
        { release: 'earlier', name: 'Earlier Event', announcement_datetime: Math.floor((now + 3600000) / 1000), announcement_datetime_utc: earlierDate, release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(2);
      expect(news[0].name).toBe('Earlier Event');
      expect(news[1].name).toBe('Later Event');
    });

    it('should filter out unconfirmed events', async () => {
      const now = Date.now();
      const mockEvents = [
        { release: 'nfp', name: 'NFP', announcement_datetime: Math.floor((now + 3600000) / 1000), announcement_datetime_utc: new Date(now + 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
        { release: 'fomc', name: 'FOMC', announcement_datetime: Math.floor((now + 7200000) / 1000), announcement_datetime_utc: new Date(now + 7200000).toISOString(), release_date_confirmed: false, event_importance: 'high', market_tier: 1 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(1);
      expect(news[0].name).toBe('NFP');
    });

    it('should filter out low/medium impact events', async () => {
      const now = Date.now();
      const mockEvents = [
        { release: 'nfp', name: 'NFP', announcement_datetime: Math.floor((now + 3600000) / 1000), announcement_datetime_utc: new Date(now + 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
        { release: 'cpi', name: 'CPI', announcement_datetime: Math.floor((now + 7200000) / 1000), announcement_datetime_utc: new Date(now + 7200000).toISOString(), release_date_confirmed: true, event_importance: 'medium', market_tier: 2 },
        { release: 'claims', name: 'Claims', announcement_datetime: Math.floor((now + 10800000) / 1000), announcement_datetime_utc: new Date(now + 10800000).toISOString(), release_date_confirmed: true, event_importance: 'low', market_tier: 3 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(1);
      expect(news[0].name).toBe('NFP');
    });

    it('should handle network error gracefully', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      await newsService.fetchNews();

      expect(newsService.getAllHighImpactNews().length).toBe(0);
      expect(newsService.getFetchError()).toBe('Network error');
    });

    it('should handle HTTP error response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await newsService.fetchNews();

      expect(newsService.getAllHighImpactNews().length).toBe(0);
      expect(newsService.getFetchError()).toContain('HTTP 500');
    });

    it('should handle invalid response format', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ not: 'an array' }),
      } as Response);

      await newsService.fetchNews();

      expect(newsService.getAllHighImpactNews().length).toBe(0);
      expect(newsService.getFetchError()).toContain('Invalid response format');
    });

    it('should filter out past events and events beyond one week', async () => {
      const now = Date.now();
      const mockEvents = [
        { release: 'past', name: 'Past Event', announcement_datetime: Math.floor((now - 3600000) / 1000), announcement_datetime_utc: new Date(now - 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
        { release: 'future', name: 'Future Event', announcement_datetime: Math.floor((now + 3600000) / 1000), announcement_datetime_utc: new Date(now + 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
        { release: 'far', name: 'Too Far Future', announcement_datetime: Math.floor((now + 8 * 24 * 60 * 60 * 1000) / 1000), announcement_datetime_utc: new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(1);
      expect(news[0].name).toBe('Future Event');
    });

    it('should parse announcement_datetime_utc when announcement_datetime not available', async () => {
      const now = Date.now();
      const mockEvents = [
        { release: 'test', name: 'Test Event', announcement_datetime_utc: new Date(now + 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(1);
      expect(news[0].name).toBe('Test Event');
    });
  });

  describe('isNewsEmbargo', () => {
    beforeEach(async () => {
      const baseTime = new Date('2026-09-15T14:00:00.000Z').getTime();

      const originalNow = Date.now;
      (global as any).Date.now = () => baseTime;

      const mockEvents = [
        { release: 'nfp', name: 'NFP', announcement_datetime: Math.floor(baseTime / 1000), announcement_datetime_utc: new Date(baseTime).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      (global as any).Date.now = originalNow;
    });

    it('should return false 1 second before embargo window (13:29:59)', () => {
      const timestamp = new Date('2026-09-15T13:29:59.000Z').getTime();
      expect(newsService.isNewsEmbargo(timestamp)).toBe(false);
    });

    it('should return true at embargo start (13:30:00 - 30 min before news)', () => {
      const timestamp = new Date('2026-09-15T13:30:00.000Z').getTime();
      expect(newsService.isNewsEmbargo(timestamp)).toBe(true);
    });

    it('should return true at news time (14:00:00)', () => {
      const timestamp = new Date('2026-09-15T14:00:00.000Z').getTime();
      expect(newsService.isNewsEmbargo(timestamp)).toBe(true);
    });

    it('should return true at embargo end (14:30:00 - 30 min after news)', () => {
      const timestamp = new Date('2026-09-15T14:30:00.000Z').getTime();
      expect(newsService.isNewsEmbargo(timestamp)).toBe(true);
    });

    it('should return false 1 second after embargo window (14:30:01)', () => {
      const timestamp = new Date('2026-09-15T14:30:01.000Z').getTime();
      expect(newsService.isNewsEmbargo(timestamp)).toBe(false);
    });

    it('should return false when no high-impact news loaded', async () => {
      const freshService = new NewsService();
      expect(freshService.isNewsEmbargo(Date.now())).toBe(false);
    });

    it('should return false when no high-impact USD news in calendar', async () => {
      const freshService = new NewsService();
      const mockEvents = [
        { release: 'ecb', name: 'ECB Rate', announcement_datetime: Math.floor((Date.now() + 3600000) / 1000), announcement_datetime_utc: new Date(Date.now() + 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'EUR', timezone: 'Europe/Berlin', data: mockEvents }),
      } as Response);

      await freshService.fetchNews();

      expect(freshService.isNewsEmbargo(Date.now())).toBe(false);
    });
  });

  describe('getNextHighImpactNews', () => {
    it('should return null when no news loaded', () => {
      expect(newsService.getNextHighImpactNews()).toBeNull();
    });

    it('should return the earliest upcoming high-impact news', async () => {
      const now = Date.now();
      const mockEvents = [
        { release: 'later', name: 'Later Event', announcement_datetime: Math.floor((now + 7200000) / 1000), announcement_datetime_utc: new Date(now + 7200000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
        { release: 'earlier', name: 'Earlier Event', announcement_datetime: Math.floor((now + 3600000) / 1000), announcement_datetime_utc: new Date(now + 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      const next = newsService.getNextHighImpactNews();
      expect(next).not.toBeNull();
      expect(next?.name).toBe('Earlier Event');
    });
  });

  describe('getAllHighImpactNews', () => {
    it('should return a copy of the internal array (immutability)', async () => {
      const mockEvents = [
        { release: 'event', name: 'Event', announcement_datetime: Math.floor((Date.now() + 3600000) / 1000), announcement_datetime_utc: new Date(Date.now() + 3600000).toISOString(), release_date_confirmed: true, event_importance: 'high', market_tier: 1 },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ currency: 'USD', timezone: 'America/New_York', data: mockEvents }),
      } as Response);

      await newsService.fetchNews();

      const news1 = newsService.getAllHighImpactNews();
      const news2 = newsService.getAllHighImpactNews();
      
      expect(news1).not.toBe(news2);
      expect(news1).toEqual(news2);
    });
  });

  describe('Resilience', () => {
    it('should not crash when fetch fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network down'));
      
      await expect(newsService.fetchNews()).resolves.not.toThrow();
    });

    it('should continue when fetch fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network down'));
      
      await newsService.fetchNews();
      
      expect(newsService.getAllHighImpactNews()).toEqual([]);
      expect(newsService.getFetchError()).toBe('Network down');
    });

    it('should return empty array and error message on failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection timeout'));
      
      await newsService.fetchNews();
      
      expect(newsService.getAllHighImpactNews()).toEqual([]);
      expect(newsService.getFetchError()).toBe('Connection timeout');
    });
  });
});