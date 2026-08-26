import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateDatabase } from '../src/db/database';
import { NewTradeInput, StrategyState } from '../src/types';

describe('StateDatabase', () => {
  let dir: string;
  let db: StateDatabase;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-db-'));
    db = new StateDatabase(dir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('initializes with WAL journal mode', () => {
    expect(db.getJournalMode()).toBe('wal');
  });

  it('persists symbol state machine status across reopen', () => {
    expect(db.getSymbolState('SOLUSDT')).toBeNull();

    db.setSymbolState('SOLUSDT', StrategyState.WAITING);
    const state = db.getSymbolState('SOLUSDT');
    expect(state?.state).toBe(StrategyState.WAITING);
    expect(state?.symbol).toBe('SOLUSDT');

    db.close();
    db = new StateDatabase(dir);

    db.setSymbolState('SOLUSDT', StrategyState.CONFIRMATION);
    expect(db.getSymbolState('SOLUSDT')?.state).toBe(StrategyState.CONFIRMATION);
  });

  it('stores and updates trades with exact string precision', () => {
    const input: NewTradeInput = {
      symbol: 'BTCUSDT',
      side: 'Buy',
      entryPrice: '65000.5',
      stopLoss: '64350.25',
      takeProfit: '66950.75',
      qty: '0.307',
      openedAt: Date.now(),
    };
    const id = db.openTrade(input);
    expect(id).toBeGreaterThan(0);

    const open = db.getOpenTrade('BTCUSDT');
    expect(open?.id).toBe(id);
    expect(open?.side).toBe('Buy');
    expect(open?.entryPrice).toBe('65000.5');
    expect(open?.stopLoss).toBe('64350.25');
    expect(open?.takeProfit).toBe('66950.75');
    expect(open?.qty).toBe('0.307');
    expect(open?.status).toBe('OPEN');
    expect(open?.pnl).toBeNull();

    const firstClose = db.closeTrade(id, '-12.345', '64350.25', Date.now());
    expect(firstClose).toBe(true);
    expect(db.getOpenTrade('BTCUSDT')).toBeNull();
    expect(db.closeTrade(id, '0', '1', Date.now())).toBe(false);

    const recent = db.getRecentClosedTrades(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].pnl).toBe('-12.345');
    expect(recent[0].exitPrice).toBe('64350.25');
    expect(recent[0].closedAt).not.toBeNull();
  });

  it('returns most recent closed trades first', () => {
    const base: NewTradeInput = {
      symbol: 'ETHUSDT',
      side: 'Sell',
      entryPrice: '3000',
      stopLoss: '3030',
      takeProfit: '2910',
      qty: '1',
      openedAt: Date.now(),
    };
    const id1 = db.openTrade(base);
    db.closeTrade(id1, '90', '2910', 1000);

    const id2 = db.openTrade({ ...base, symbol: 'BTCUSDT' });
    db.closeTrade(id2, '-30', '3030', 2000);

    const recent = db.getRecentClosedTrades(2);
    expect(recent.map((t) => t.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});
