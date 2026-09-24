import { Decimal } from 'decimal.js';
import { BotConfig } from './config/env';

export type Direction = 'BULLISH' | 'BEARISH';
export type StructureBreakKind = 'BOS' | 'CHOCH';
export type SwingType = 'HIGH' | 'LOW';
export type Timeframe = '1' | '3' | '5' | '15' | '30' | '60' | '120' | '240' | '360' | '720' | 'D' | 'W' | 'M';
export type TradeSide = 'Buy' | 'Sell';
export type TradeStatus = 'OPEN' | 'CLOSED';

export { BotConfig };

export enum Trend {
  UP = 'UP',
  DOWN = 'DOWN',
}

export enum StrategyState {
  SCANNING = 'SCANNING',
  WAITING = 'WAITING',
  CONFIRMATION = 'CONFIRMATION',
  ENTRY_STAGED = 'ENTRY_STAGED',
  IN_TRADE = 'IN_TRADE',
}

export interface Candle {
  readonly timestamp: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

export interface SwingPoint {
  readonly type: SwingType;
  readonly index: number;
  readonly timestamp: number;
  readonly price: Decimal;
}

export interface FVG {
  readonly direction: Direction;
  readonly index: number;
  readonly timestamp: number;
  readonly top: Decimal;
  readonly bottom: Decimal;
}

export interface StructureBreak {
  readonly kind: StructureBreakKind;
  readonly direction: Direction;
  readonly brokenSwing: SwingPoint;
  readonly candleIndex: number;
  readonly impulseFactor: Decimal;
}

export interface OrderBlock {
  readonly direction: Direction;
  readonly index: number;
  readonly timestamp: number;
  readonly top: Decimal;
  readonly bottom: Decimal;
  readonly breakEvent: StructureBreak;
  readonly invalidated: boolean;
}

export interface InstrumentInfo {
  readonly symbol: string;
  readonly tickSize: string;
  readonly qtyStep: string;
  readonly minOrderQty: string;
  readonly maxOrderQty: string;
}

export interface SymbolRuntimeState {
  readonly symbol: string;
  readonly state: StrategyState;
  readonly updatedAt: number;
}

export interface TradeRecord {
  readonly id: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly entryPrice: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly qty: string;
  readonly status: TradeStatus;
  readonly pnl: string | null;
  readonly exitPrice: string | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly orderId: string | null;
}

export interface NewTradeInput {
  readonly symbol: string;
  readonly side: TradeSide;
  readonly entryPrice: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly qty: string;
  readonly openedAt: number;
  readonly orderId?: string | null;
}

export interface MarketOrderRequest {
  readonly symbol: string;
  readonly side: TradeSide;
  readonly qty: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly orderLinkId: string;
}

export interface ScenarioLevels {
  readonly entry: Decimal;
  readonly stopLoss: Decimal;
  readonly takeProfit: Decimal;
}

export interface ZoneDetails {
  readonly type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION';
  readonly top: Decimal;
  readonly bottom: Decimal;
  readonly timeframe: string;
  readonly direction: Direction;
  readonly timestamp: number;
}

export interface IScenario {
  readonly id: number;
  readonly name: string;
  evaluate(patternData: any): boolean;
  getLevels(): ScenarioLevels;
  getReason(): string;
  getZoneDetails(): ZoneDetails | null;
  getStructureDetails(): StructureDetails | null;
}

export interface StructureDetails {
  type: 'SMS' | 'CHoCH' | 'BOS';
  timestamp: number;
  price: Decimal;
}

export type ScenarioConstructor = new (deps: ScenarioDeps) => IScenario;

export interface ScenarioDeps {
  readonly symbol: string;
  readonly instrument: InstrumentInfo;
  readonly riskManager: any;
  readonly notifier: any;
  readonly db: any;
}
