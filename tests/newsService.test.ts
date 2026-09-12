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

  const createMockFetchResponse = (events: any[]): Response => {
    return {
      ok: true,
      status: 200,
      json: async () => events,
    } as Response;
  };

  describe('fetchNews', () => {
    it('should filter and store only USD High impact events', async () => {
      const mockEvents = [
        { id: '1', country: 'USD', impact: 'High', title: 'NFP', date: new Date(Date.now() + 3600000).toISOString(), forecast: '200K', previous: '180K' },
        { id: '2', country: 'EUR', impact: 'High', title: 'ECB Rate', date: new Date(Date.now() + 7200000).toISOString(), forecast: '3.5%', previous: '3.5%' },
        { id: '3', country: 'USD', impact: 'Medium', title: 'CPI', date: new Date(Date.now() + 10800000).toISOString(), forecast: '3.2%', previous: '3.1%' },
        { id: '4', country: 'USD', impact: 'Low', title: 'Unemployment Claims', date: new Date(Date.now() + 14400000).toISOString(), forecast: '210K', previous: '215K' },
        { id: '5', country: 'USD', impact: 'High', title: 'FOMC Minutes', date: new Date(Date.now() + 18000000).toISOString(), forecast: '', previous: '' },
      ];

      global.fetch = jest.fn().mockResolvedValue(createMockFetchResponse(mockEvents));

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(2);
      expect(news[0].title).toBe('NFP');
      expect(news[1].title).toBe('FOMC Minutes');
      expect(news.every(n => n.country === 'USD')).toBe(true);
      expect(news.every(n => n.impact === 'High')).toBe(true);
    });

    it('should sort events by timestamp ascending', async () => {
      const laterDate = new Date(Date.now() + 7200000).toISOString();
      const earlierDate = new Date(Date.now() + 3600000).toISOString();

      const mockEvents = [
        { id: '1', country: 'USD', impact: 'High', title: 'Later Event', date: laterDate },
        { id: '2', country: 'USD', impact: 'High', title: 'Earlier Event', date: earlierDate },
      ];

      global.fetch = jest.fn().mockResolvedValue(createMockFetchResponse(mockEvents));

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(2);
      expect(news[0].title).toBe('Earlier Event');
      expect(news[1].title).toBe('Later Event');
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
        { id: '1', country: 'USD', impact: 'High', title: 'Past Event', date: new Date(now - 3600000).toISOString() },
        { id: '2', country: 'USD', impact: 'High', title: 'Future Event', date: new Date(now + 3600000).toISOString() },
        { id: '3', country: 'USD', impact: 'High', title: 'Too Far Future', date: new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString() },
      ];

      global.fetch = jest.fn().mockResolvedValue(createMockFetchResponse(mockEvents));

      await newsService.fetchNews();

      const news = newsService.getAllHighImpactNews();
      expect(news.length).toBe(1);
      expect(news[0].title).toBe('Future Event');
    });
  });

  describe('isNewsEmbargo', () => {
    beforeEach(async () => {
      // Use a fixed base time for deterministic tests
      const baseTime = new Date('2026-09-15T14:00:00.000Z').getTime(); // Monday 14:00 UTC
      
      // Mock Date.now for deterministic tests
      const originalNow = Date.now;
      (global as any).Date.now = () => baseTime;

      const mockEvents = [
        { 
          id: '1', 
          country: 'USD', 
          impact: 'High', 
          title: 'NFP', 
          date: new Date(baseTime).toISOString(), // 14:00 UTC
        },
      ];

      global.fetch = jest.fn().mockResolvedValue(createMockFetchResponse(mockEvents));

      await newsService.fetchNews();

      // Restore Date.now
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
        { id: '1', country: 'EUR', impact: 'High', title: 'ECB Rate', date: new Date(Date.now() + 3600000).toISOString() },
      ];

      global.fetch = jest.fn().mockResolvedValue(createMockFetchResponse(mockEvents));
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
        { id: '1', country: 'USD', impact: 'High', title: 'Later Event', date: new Date(now + 7200000).toISOString() },
        { id: '2', country: 'USD', impact: 'High', title: 'Earlier Event', date: new Date(now + 3600000).toISOString() },
      ];

      global.fetch = jest.fn().mockResolvedValue(createMockFetchResponse(mockEvents));
      await newsService.fetchNews();

      const next = newsService.getNextHighImpactNews();
      expect(next).not.toBeNull();
      expect(next?.title).toBe('Earlier Event');
    });
  });

  describe('getAllHighImpactNews', () => {
    it('should return a copy of the internal array (immutability)', async () => {
      const mockEvents = [
        { id: '1', country: 'USD', impact: 'High', title: 'Event', date: new Date(Date.now() + 3600000).toISOString() },
      ];

      global.fetch = jest.fn().mockResolvedValue(createMockFetchResponse(mockEvents));
      await newsService.fetchNews();

      const news1 = newsService.getAllHighImpactNews();
      const news2 = newsService.getAllHighImpactNews();
      
      expect(news1).not.toBe(news2); // Different array references
      expect(news1).toEqual(news2); // Same content
    });
  });

  describe('Resilience', () => {
    it('should not crash when fetch fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network down'));
      
      await expect(newsService.fetchNews()).resolves.not.toThrow();
    });

    it('should continue when fetch fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network down'));
      
      // Should not throw
      await expect(newsService.fetchNews()).resolves.not.toThrow();
    });

    it('should return empty array and error message on failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection timeout'));
      
      await newsService.fetchNews();
      
      expect(newsService.getAllHighImpactNews()).toEqual([]);
      expect(newsService.getFetchError()).toBe('Connection timeout');
    });
  });
});