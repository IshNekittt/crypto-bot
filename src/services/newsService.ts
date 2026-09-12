import { logger } from '../utils/logger';

const FXMACRODATA_URL = 'https://api.fxmacrodata.com/v1/calendar/usd';
const EMBARGO_WINDOW_MS = 30 * 60 * 1000;

interface FXMacroResponse {
  currency: string;
  timezone: string;
  data: FXMacroEvent[];
}

interface FXMacroEvent {
  release: string;
  name: string;
  announcement_datetime?: number;
  announcement_datetime_utc?: string;
  release_date_confirmed: boolean;
  event_importance: string;
  market_tier: number;
  id?: string;
}

export interface NewsEvent {
  id: string;
  name: string;
  timestamp: number;
}

export class NewsService {
  private highImpactNews: NewsEvent[] = [];
  private lastFetchTime: number = 0;
  private fetchError: string | null = null;

  async fetchNews(): Promise<void> {
    try {
      logger.info('Fetching economic calendar from FXMacroData...');
      const response = await fetch(FXMACRODATA_URL, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as FXMacroResponse;

      if (!data?.data || !Array.isArray(data.data)) {
        throw new Error('Invalid response format: expected data array');
      }

      const now = Date.now();
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

      this.highImpactNews = data.data
        .filter((event: FXMacroEvent) => {
          const isHighImpact = event.event_importance === 'high' || event.market_tier === 1;
          const isConfirmed = event.release_date_confirmed === true;
          const hasValidTime = event.announcement_datetime || event.announcement_datetime_utc;
          return isHighImpact && isConfirmed && hasValidTime;
        })
        .map((event: FXMacroEvent) => {
          let timestamp: number;
          if (event.announcement_datetime) {
            timestamp = event.announcement_datetime * 1000;
          } else if (event.announcement_datetime_utc) {
            timestamp = new Date(event.announcement_datetime_utc).getTime();
          } else {
            timestamp = now;
          }
          return {
            id: event.id || event.release || Math.random().toString(36).substring(7),
            name: event.name || event.release || 'Unknown Event',
            timestamp,
          };
        })
        .filter((event: NewsEvent) => {
          return event.timestamp >= now && event.timestamp <= now + oneWeekMs;
        });

      this.highImpactNews.sort((a, b) => a.timestamp - b.timestamp);
      this.lastFetchTime = Date.now();
      this.fetchError = null;

      logger.info(`Loaded ${this.highImpactNews.length} high-impact USD news events for this week`);
      if (this.highImpactNews.length > 0) {
        const nextNews = this.highImpactNews[0];
        logger.info(`Next high-impact news: ${nextNews.name} at ${new Date(nextNews.timestamp).toISOString()}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fetchError = message;
      this.highImpactNews = [];
      logger.warn(`[WARN] FXMacroData API unavailable: ${message}. News embargo disabled.`);
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

  getNextHighImpactNews(): { name: string; timestamp: number } | null {
    const confirmed = this.highImpactNews.filter(n => n.timestamp > Date.now());
    if (confirmed.length === 0) {
      return null;
    }
    const next = confirmed[0];
    return {
      name: next.name,
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