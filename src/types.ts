import { Decimal } from 'decimal.js';
import { BotConfig } from './config/env';

export type Direction = 'BULLISH' | 'BEARISH';
export type StructureBreakKind = 'BOS' | 'CHOCH';

/**
 * Scenario IDs the live `ScenarioRouter` can construct.
 *
 * Type-level mirror of `REGISTERED_SCENARIO_IDS` (`src/engine/scenarioRegistry.ts`),
 * which stays the runtime single source of truth. A scenario implementation pins
 * its own id to this union, so adding a scenario forces both sides to move
 * together instead of drifting silently. Archived ids (2-4, 6-11, 13, 16) are
 * intentionally absent: no runtime path can schedule them.
 */
export type ScenarioId = 1 | 5 | 12 | 14 | 15;
export type SwingType = 'HIGH' | 'LOW';
export type Timeframe = '1' | '3' | '5' | '15' | '30' | '60' | '120' | '240' | '360' | '720' | 'D' | 'W' | 'M';
export type TradeSide = 'Buy' | 'Sell';
export type TradeStatus = 'OPEN' | 'CLOSED';
export type OrderType = 'Market' | 'Limit';
export type TimeInForce = 'IOC' | 'GTC' | 'FOK';

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
  SNIPER_MODE = 'SNIPER_MODE',
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

export interface OpenOrder {
  readonly orderId: string;
  readonly orderLinkId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly orderType: OrderType;
  readonly price: string | null; // null for market orders
  readonly qty: string;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly createdAt: number;
  readonly status: 'New' | 'PartiallyFilled' | 'Filled' | 'Cancelled' | 'Rejected';
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

export interface LimitOrderRequest {
  readonly symbol: string;
  readonly side: TradeSide;
  readonly qty: string;
  readonly price: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly orderLinkId: string;
  readonly timeInForce: TimeInForce;
}

export type OrderRequest = MarketOrderRequest | LimitOrderRequest;

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

export interface SniperZone {
  readonly top: Decimal;
  readonly bottom: Decimal;
  readonly direction: Direction;
  readonly scenarioId: string;
  readonly scenarioName: string;
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

/**
 * Every structure that can act as a trade trigger and therefore be burned into
 * `mitigatedStructures`. `SWEEP` covers SFP/Turtle Soup entries whose trigger is
 * the sweep candle itself rather than a CHoCH/BOS/SMS break.
 */
export type StructureType = 'SMS' | 'CHoCH' | 'BOS' | 'SWEEP';

export interface StructureDetails {
  type?: StructureType;
  timestamp: number;
  price: Decimal;
  direction?: 'BULLISH' | 'BEARISH';
}

export interface MitigatedZone {
  type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION';
  top: string;
  bottom: string;
  timeframe: string;
  direction: string;
  timestamp: number;
}

export interface MitigatedStructure {
  type: StructureType;
  timestamp: number;
  price: string;
  direction: 'BULLISH' | 'BEARISH';
}

export type ScenarioConstructor = new (deps: ScenarioDeps) => IScenario;

export interface TradeManagementState {
  milestone1Triggered: boolean;
  milestone2Triggered: boolean;
  initialTotalR: string;
  initialQty: string;
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
  readonly managementState: TradeManagementState | null;
}

export interface OpenTrade {
  readonly entryPrice: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly qty: string;
  readonly side: TradeSide;
  readonly entryTime: number;
  readonly scenarioId: number;
  readonly scenarioName: string;
  readonly managementState: TradeManagementState | null;
}

export interface ScenarioDeps {
  readonly symbol: string;
  readonly instrument: InstrumentInfo;
  readonly riskManager: any;
  readonly notifier: any;
  readonly db: any;
}
