import { logger } from '../utils/logger';

const FOREX_FACTORY_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const EMBARGO_WINDOW_MS = 30 * 60 * 1000;

export interface NewsEvent {
  id: string;
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
  timestamp: number;
}

export class NewsService {
  private highImpactNews: NewsEvent[] = [];
  private lastFetchTime: number = 0;
  private fetchError: string | null = null;

  async fetchNews(): Promise<void> {
    try {
      logger.info('Fetching economic calendar from ForexFactory...');
      const response = await fetch(FOREX_FACTORY_URL, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error('Invalid response format: expected array');
      }

      const now = Date.now();
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

      this.highImpactNews = data
        .filter((event: any) => {
          return event.country === 'USD' && 
                 event.impact === 'High' &&
                 event.date &&
                 !isNaN(new Date(event.date).getTime());
        })
        .map((event: any) => ({
          id: event.id || Math.random().toString(36).substring(7),
          title: event.title || event.event || 'Unknown Event',
          country: event.country,
          date: event.date,
          impact: event.impact,
          forecast: event.forecast || '',
          previous: event.previous || '',
          timestamp: new Date(event.date).getTime(),
        }))
        .filter((event: NewsEvent) => {
          return event.timestamp >= now && event.timestamp <= now + oneWeekMs;
        });

      this.highImpactNews.sort((a, b) => a.timestamp - b.timestamp);
      this.lastFetchTime = now;
      this.fetchError = null;

      logger.info(`Loaded ${this.highImpactNews.length} high-impact USD news events for this week`);
      if (this.highImpactNews.length > 0) {
        const nextNews = this.highImpactNews[0];
        logger.info(`Next high-impact news: ${nextNews.title} at ${new Date(nextNews.timestamp).toISOString()}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fetchError = message;
      this.highImpactNews = [];
      logger.warn(`Failed to fetch economic calendar: ${message}. News embargo disabled.`);
    }
  }

  isNewsEmbargo(timestamp: number): boolean {
    if (this.highImpactNews.length === 0) {
      return false;
    }

    for (const news of this.highImpactNews) {
      const embargoStart = news.timestamp - EMBARGO_WINDOW_MS;
      const embargoEnd = news.timestamp + EMBARGO_WINDOW_MS;
      
      if (timestamp >= embargoStart && timestamp <= embargoEnd) {
        return true;
      }
    }
    return false;
  }

  getNextHighImpactNews(): { title: string; timestamp: number } | null {
    if (this.highImpactNews.length === 0) {
      return null;
    }
    const next = this.highImpactNews[0];
    return {
      title: next.title,
      timestamp: next.timestamp,
    };
  }

  getAllHighImpactNews(): NewsEvent[] {
    return [...this.highImpactNews];
  }

  getFetchError(): string | null {
    return this.fetchError;
  }

  getLastFetchTime(): number {
    return this.lastFetchTime;
  }
}

export function createNewsService(): NewsService {
  return new NewsService();
}