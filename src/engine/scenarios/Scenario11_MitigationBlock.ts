import { BaseScenario } from "../baseScenario";
import { Decimal } from "decimal.js";

export class Scenario11_MitigationBlock extends BaseScenario {
  private static rejectionStats = {
    missingData: 0,
    killzone: 0,
    noSms: 0,
    invalidSmsPattern: 0,
    noChoch: 0,
    displacement: 0,
    noMitigationBlock: 0,
    noRetest: 0,
    premiumDiscount: 0,
    totalEvals: 0,
  };

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      missingData: 0,
      killzone: 0,
      noSms: 0,
      invalidSmsPattern: 0,
      noChoch: 0,
      displacement: 0,
      noMitigationBlock: 0,
      noRetest: 0,
      premiumDiscount: 0,
      totalEvals: 0,
    };
  }

  constructor() {
    super(11, "Mitigation Block");
  }

  private validateSmsPattern(
    sms: any,
    structures: any[],
    zones: any[],
  ): {
    isValid: boolean;
    mitigationBlock: any;
    chochAfterSms: any;
    rejectionReason?: string;
  } {
    const smsDirection = sms.direction;
    const expectedChochDirection =
      smsDirection === "BEARISH" ? "BEARISH" : "BULLISH";

    // Find ALL CHoCHs after this SMS within 8H, take the LAST (newest) one
    const validChochs = structures.filter(
      (s: any) =>
        s.type === "CHOCH" &&
        s.direction === expectedChochDirection &&
        s.timestamp > sms.timestamp &&
        s.timestamp <= sms.timestamp + 8 * 3600 * 1000,
    );

    if (!validChochs.length) {
      return {
        isValid: false,
        mitigationBlock: null,
        chochAfterSms: null,
        rejectionReason: "No CHoCH after SMS within 8H",
      };
    }

    // Take the LAST (newest) CHoCH after this SMS
    const chochAfterSms = validChochs[validChochs.length - 1];

    if (!this.isValidDisplacement(chochAfterSms, 1.5)) {
      return {
        isValid: false,
        mitigationBlock: null,
        chochAfterSms: null,
        rejectionReason: "CHoCH after SMS displacement < 1.5 ATR",
      };
    }

    // Find the LAST (newest) OB before SMS that formed the failed swing
    const mbObs = zones.filter(
      (z: any) =>
        z.type === "OB" &&
        z.direction === (smsDirection === "BEARISH" ? "BULLISH" : "BEARISH") &&
        z.timestamp < sms.timestamp &&
        !z.mitigated,
    );

    if (!mbObs.length) {
      return {
        isValid: false,
        mitigationBlock: null,
        chochAfterSms: null,
        rejectionReason: "No Mitigation Block OB found before SMS",
      };
    }

    // The LAST OB before SMS (most recent) = mbObs[mbObs.length - 1]
    // Array is ordered by timestamp ascending, so last element is newest
    return {
      isValid: true,
      mitigationBlock: mbObs[mbObs.length - 1],
      chochAfterSms,
    };
  }

  private checkPremiumDiscount(
    entry: Decimal,
    tradeDirection: "BULLISH" | "BEARISH",
    smsPrice: Decimal,
    chochPrice: Decimal,
  ): boolean {
    const high = Decimal.max(smsPrice, chochPrice);
    const low = Decimal.min(smsPrice, chochPrice);
    const equilibrium = low.plus(high.minus(low).div(2));

    if (tradeDirection === "BULLISH") return entry.lt(equilibrium); // Лонг строго в Discount
    return entry.gt(equilibrium); // Шорт строго в Premium
  }

  override evaluate(patternData: any): boolean {
    Scenario11_MitigationBlock.rejectionStats.totalEvals++;

    const { candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !structures?.length || !zones?.length) {
      Scenario11_MitigationBlock.rejectionStats.missingData++;
      return false;
    }

    if (patternData.currentKillzone === "NONE") {
      this.logRejection("Not in active killzone");
      Scenario11_MitigationBlock.rejectionStats.killzone++;
      return false;
    }

    const candleTimestamp = candles15m[candles15m.length - 1].timestamp;
    if (!this.isInKillzone(candleTimestamp)) {
      this.logRejection("Not in active killzone");
      Scenario11_MitigationBlock.rejectionStats.killzone++;
      return false;
    }

    // Find the LAST (newest) SMS in the structures array
    const smsList = structures.filter((s: any) => s.type === "SMS");
    if (!smsList.length) {
      this.logRejection("No SMS (Smart Money Shift) detected");
      Scenario11_MitigationBlock.rejectionStats.noSms++;
      return false;
    }
    const sms = smsList[smsList.length - 1]; // Самый свежий SMS!

    const validation = this.validateSmsPattern(sms, structures, zones);
    if (!validation.isValid) {
      const reason = validation.rejectionReason || "Invalid SMS pattern";
      this.logRejection(reason);
      if (reason.includes("CHoCH after SMS"))
        Scenario11_MitigationBlock.rejectionStats.noChoch++;
      else if (reason.includes("displacement"))
        Scenario11_MitigationBlock.rejectionStats.displacement++;
      else if (reason.includes("Mitigation Block OB"))
        Scenario11_MitigationBlock.rejectionStats.noMitigationBlock++;
      else Scenario11_MitigationBlock.rejectionStats.invalidSmsPattern++;
      return false;
    }

    const { mitigationBlock, chochAfterSms } = validation;
    const tradeDirection = chochAfterSms.direction;
    const atr = patternData.atr15m || new Decimal("0.01");

    // Ретест должен происходить на ТЕКУЩЕЙ свече (той, что только закрылась)
    const currentCandle = candles15m[candles15m.length - 1];

    // Свеча должна быть ПОСЛЕ CHoCH, но не позднее 12 часов после слома
    const timeSinceChoch = currentCandle.timestamp - chochAfterSms.timestamp;
    if (timeSinceChoch <= 0) {
      Scenario11_MitigationBlock.rejectionStats.noRetest++;
      return false;
    }
    if (timeSinceChoch > 12 * 3600 * 1000) {
      Scenario11_MitigationBlock.rejectionStats.noRetest++;
      return false;
    }

    const currentHigh = new Decimal(currentCandle.high);
    const currentLow = new Decimal(currentCandle.low);
    const currentClose = new Decimal(currentCandle.close);
    const currentOpen = new Decimal(currentCandle.open);

    const mbTop = new Decimal(mitigationBlock.top);
    const mbBottom = new Decimal(mitigationBlock.bottom);

    // Ретест — касание зоны блока тенями ТЕКУЩЕЙ свечи
    const touchedMb =
      tradeDirection === "BULLISH"
        ? currentLow.lte(mbTop) && currentHigh.gte(mbBottom)
        : currentHigh.gte(mbBottom) && currentLow.lte(mbTop);

    // Свеча должна закрыться в направлении сделки И внутри зоны блока
    const closedInDirectionAndZone =
      tradeDirection === "BULLISH"
        ? currentClose.gt(currentOpen) &&
          currentClose.gte(mbBottom) &&
          currentClose.lte(mbTop)
        : currentClose.lt(currentOpen) &&
          currentClose.lte(mbTop) &&
          currentClose.gte(mbBottom);

    if (!touchedMb || !closedInDirectionAndZone) {
      Scenario11_MitigationBlock.rejectionStats.noRetest++;
      return false;
    }

    // Entry на закрытии ТЕКУЩЕЙ свечи
    const entry = new Decimal(currentCandle.close);

    // Premium/Discount check at the entry point
    // Dynamic equilibrium based on the impulse from SMS price to CHoCH price
    if (
      !this.checkPremiumDiscount(
        entry,
        tradeDirection,
        new Decimal(sms.price),
        new Decimal(chochAfterSms.price),
      )
    ) {
      this.logRejection("Entry not in correct Premium/Discount zone");
      Scenario11_MitigationBlock.rejectionStats.premiumDiscount++;
      return false;
    }

    const levels = this.calculateLevels(
      entry,
      { top: mitigationBlock.top, bottom: mitigationBlock.bottom, direction: tradeDirection },
      tradeDirection,
      atr,
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    this.setReason(
      `Mitigation Block: ${sms.direction} SMS + ${tradeDirection} CHoCH + MB Retest | P/D Valid`,
    );
    
    // Set structure details for mitigation tracking (CHoCH after SMS is the trigger structure)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: chochAfterSms.timestamp,
      price: chochAfterSms.price,
    });
    
    return true;
  }
}