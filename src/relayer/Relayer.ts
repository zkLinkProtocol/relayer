import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { utils as ethersUtils } from "ethers";
import { FillStatus, V3Deposit, V3DepositWithBlock } from "../interfaces";
import {
  BigNumber,
  bnZero,
  bnUint256Max,
  RelayerUnfilledDeposit,
  blockExplorerLink,
  createFormatFunction,
  formatFeePct,
  getCurrentTime,
  getNetworkName,
  getUnfilledDeposits,
  isDefined,
  winston,
  fixedPointAdjustment,
  TransactionResponse,
} from "../utils";
import { RelayerClients } from "./RelayerClientHelper";
import { RelayerConfig } from "./RelayerConfig";

const { getAddress } = ethersUtils;
const { isDepositSpedUp, isMessageEmpty, resolveDepositMessage } = sdkUtils;
const UNPROFITABLE_DEPOSIT_NOTICE_PERIOD = 60 * 60; // 1 hour
const HUB_SPOKE_BLOCK_LAG = 2; // Permit SpokePool timestamps to be ahead of the HubPool by 2 HubPool blocks.

type RepaymentFee = { paymentChainId: number; lpFeePct: BigNumber };
type BatchLPFees = { [depositKey: string]: RepaymentFee[] };

export class Relayer {
  public readonly relayerAddress: string;
  public readonly fillStatus: { [depositHash: string]: number } = {};
  private pendingTxnReceipts: { [chainId: number]: Promise<TransactionResponse[]> } = {};

  private hubPoolBlockBuffer: number;
  private refundRecipient: string;
  private l2Recipient: string

  constructor(
    relayerAddress: string,
    readonly logger: winston.Logger,
    readonly clients: RelayerClients,
    readonly config: RelayerConfig
  ) {
    this.relayerAddress = getAddress(relayerAddress);
    this.refundRecipient = config.refundRecipient ?? this.relayerAddress;
    this.l2Recipient = config.l2Recipient ?? this.relayerAddress;
  }

  /**
   * @description For a given deposit, apply relayer-specific filtering to determine whether it should be filled.
   * @param deposit Deposit object.
   * @param invalidFills An array of any invalid fills detected for this deposit.
   * @returns A boolean indicator determining whether the relayer configuration permits the deposit to be filled.
   */
  filterDeposit({ deposit, invalidFills }: RelayerUnfilledDeposit): boolean {
    const { nonce, originChainId, destinationChainId, intentOwner, intentReceiver, blockNumber } = deposit;
    const { hubPoolClient, spokePoolClients } = this.clients;
    const { ignoredAddresses, acceptInvalidFills } = this.config;
    const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];

    if (!this.routeEnabled(originChainId, destinationChainId)) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit from or to disabled chains.",
        deposit,
        enabledOriginChains: this.config.relayerOriginChains,
        enabledDestinationChains: this.config.relayerDestinationChains,
      });
      return false;
    }

    const minConfirmations = 0;
    const { latestBlockSearched } = spokePoolClients[originChainId];
    if (latestBlockSearched - blockNumber < minConfirmations) {
      this.logger.debug({
        at: "Relayer::evaluateFill",
        message: `Skipping ${srcChain} deposit due to insufficient deposit confirmations.`,
        nonce,
        intentOwner,
        blockNumber,
        confirmations: latestBlockSearched - blockNumber,
        minConfirmations,
        transactionHash: deposit.transactionHash,
      });
      return false;
    }

    // Skip deposits with quoteTimestamp in the future (impossible to know HubPool utilization => LP fee cannot be computed).
    if (deposit.quoteTimestamp - hubPoolClient.currentTime > this.hubPoolBlockBuffer) {
      this.logger.debug({
        at: "Relayer::evaluateFill",
        message: `Skipping ${srcChain} deposit due to future quoteTimestamp.`,
        currentTime: hubPoolClient.currentTime,
        quoteTimestamp: deposit.quoteTimestamp,
        buffer: this.hubPoolBlockBuffer,
        transactionHash: deposit.transactionHash,
      });
      return false;
    }

    if (ignoredAddresses?.includes(getAddress(intentOwner)) || ignoredAddresses?.includes(getAddress(intentReceiver))) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: `Ignoring ${srcChain} deposit destined for ${dstChain}.`,
        intentOwner,
        intentReceiver,
        transactionHash: deposit.transactionHash,
      });
      return false;
    }

    // It would be preferable to use host time since it's more reliably up-to-date, but this creates issues in test.
    const currentTime = spokePoolClients[destinationChainId].getCurrentTime();
    if (deposit.fillDeadline <= currentTime) {
      return false;
    }

    if (deposit.exclusivityDeadline > currentTime && getAddress(deposit.exclusiveRelayer) !== this.relayerAddress) {
      return false;
    }

    // Skip deposit with message if sending fills with messages is not supported.
    if (!this.config.sendingMessageRelaysEnabled && !isMessageEmpty(resolveDepositMessage(deposit))) {
      this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
        at: "Relayer::filterDeposit",
        message: "Skipping fill for deposit with message",
        depositUpdated: isDepositSpedUp(deposit),
        deposit,
      });
      return false;
    }

    // Skip deposits that contain invalid fills from the same relayer. This prevents potential corrupted data from
    // making the same relayer fill a deposit multiple times.
    if (!acceptInvalidFills && invalidFills.some((fill) => fill.relayer === this.relayerAddress)) {
      this.logger.error({
        at: "Relayer::filterDeposit",
        message: "👨‍👧‍👦 Skipping deposit with invalid fills from the same relayer",
        deposit,
        invalidFills,
        destinationChainId,
      });
      return false;
    }

    // The deposit passed all checks, so we can include it in the list of unfilled deposits.
    return true;
  }

  /**
   * @description Retrieve the complete array of unfilled deposits and filter out deposits we can't or choose
   * not to support.
   * @returns An array of filtered RelayerUnfilledDeposit objects.
   */
  private _getUnfilledDeposits(): Record<number, RelayerUnfilledDeposit[]> {
    const { spokePoolClients } = this.clients;
    const { relayerDestinationChains } = this.config;

    // Filter the resulting deposits according to relayer configuration.
    return Object.fromEntries(
      Object.values(spokePoolClients)
        .filter(({ chainId }) => relayerDestinationChains?.includes(chainId) ?? true)
        .map(({ chainId: destinationChainId }) => [
          destinationChainId,
          getUnfilledDeposits(destinationChainId, spokePoolClients, this.fillStatus).filter((deposit) =>
            this.filterDeposit(deposit)
          ),
        ])
    );
  }

  /**
   * @description Validate whether the origin and destination chain combination is permitted by relayer config.
   * @param originChainId chain ID for the deposit.
   * @param destinationChainId Chain ID of a prospective fill.
   * @returns True if the route is permitted by config (or enabled by default), otherwise false.
   */
  routeEnabled(originChainId: number, destinationChainId: number): boolean {
    const { relayerOriginChains: originChains, relayerDestinationChains: destinationChains } = this.config;

    if (originChains?.length > 0 && !originChains.includes(originChainId)) {
      return false;
    }

    if (destinationChains?.length > 0 && !destinationChains.includes(destinationChainId)) {
      return false;
    }

    return true;
  }

  computeRequiredDepositConfirmations(
    deposits: V3Deposit[],
    destinationChainId: number
  ): { [chainId: number]: number } {
    const { profitClient, tokenClient } = this.clients;

    // Sum the total unfilled deposit amount per origin chain and set a MDC for that chain.
    // Filter out deposits where the relayer doesn't have the balance to make the fill.
    const unfilledDepositAmountsPerChain: { [chainId: number]: BigNumber } = deposits
      .filter((deposit) => tokenClient.hasBalanceForFill(deposit))
      .reduce((agg, deposit) => {
        const unfilledAmountUsd = profitClient.getFillAmountInUsd(deposit);
        agg[deposit.originChainId] = (agg[deposit.originChainId] ?? bnZero).add(unfilledAmountUsd);
        return agg;
      }, {});

    // Set the MDC for each origin chain equal to lowest threshold greater than the unfilled USD deposit amount.
    const mdcPerChain = Object.fromEntries(
      Object.entries(unfilledDepositAmountsPerChain).map(([chainId, unfilledAmount]) => {
        // If no thresholds are greater than unfilled amount, then use fallback which should have largest MDCs.
        return [chainId, 0];
      })
    );

    const dstChain = getNetworkName(destinationChainId);
    this.logger.debug({
      at: "Relayer::computeRequiredDepositConfirmations",
      message: `Setting minimum ${dstChain} deposit confirmation based on origin chain aggregate deposit amount.`,
      unfilledDepositAmountsPerChain,
      mdcPerChain,
    });

    return mdcPerChain;
  }

  // Iterate over all unfilled deposits. For each unfilled deposit, check that:
  // a) it exceeds the minimum number of required block confirmations,
  // b) the token balance client has enough tokens to fill it,
  // c) the fill is profitable.
  // If all hold true then complete the fill. If there is insufficient balance to complete the fill and slow fills are
  // enabled then request a slow fill instead.
  async evaluateFill(
    deposit: V3DepositWithBlock,
    fillStatus: number,
    lpFees: RepaymentFee[],
  ): Promise<void> {
    const { destinationChainId, originChainId } = deposit;
    const { tokenClient } = this.clients;

    if (tokenClient.hasBalanceForFill(deposit)) {
        this.fillRelay(deposit, lpFees[0]["paymentChainId"], lpFees[0]["lpFeePct"], this.refundRecipient, this.l2Recipient, undefined);
        // Update local balance to account for the enqueued fill.
        tokenClient.decrementLocalBalance(destinationChainId, deposit.outputToken, deposit.outputAmount);
    } else {
      // TokenClient.getBalance returns that we don't have enough balance to submit the fast fill.
      // At this point, capture the shortfall so that the inventory manager can rebalance the token inventory.
      tokenClient.captureTokenShortfallForFill(deposit);
    }
  }

  /**
   * For a given deposit, map its relevant attributes to a string to be used as a lookup into the LP fee structure.
   * @param relayData An object consisting of an originChainId, inputToken, inputAmount and quoteTimestamp.
   * @returns A string identifying the deposit in a BatchLPFees object.
   */
  getLPFeeKey(relayData: Pick<V3Deposit, "originChainId" | "inputToken" | "inputAmount" | "quoteTimestamp">): string {
    return `${relayData.originChainId}-${relayData.inputToken}-${relayData.inputAmount}-${relayData.quoteTimestamp}`;
  }

  /**
   * For a given destination chain, evaluate and optionally fill each unfilled deposit. Note that each fill should be
   * evaluated sequentially in order to ensure atomic balance updates.
   * @param deposits An array of deposits destined for the same destination chain.
   * @param repaymentChainId
   * @returns void
   */
  async evaluateFills(
    deposits: (V3DepositWithBlock & { fillStatus: number })[],
    repaymentChainId: { [chainId: number]: number }
  ): Promise<void> {
    for (let i = 0; i < deposits.length; ++i) {
      const { fillStatus, ...deposit } = deposits[i];
      const paymentChainId = repaymentChainId[deposit.destinationChainId] == 0 ? deposit.originChainId : repaymentChainId[deposit.destinationChainId];
      const relayerLpFees = [{ paymentChainId, lpFeePct: bnZero }];
      await this.evaluateFill(
        deposit,
        fillStatus,
        relayerLpFees,
      );
    }
  }

  /**
   * For an array of unfilled deposits, compute the applicable LP fee for each. Fees are computed for all possible
   * repayment chains which include origin, destination, all slow-withdrawal chains and mainnet.
   * @param deposits An array of deposits.
   * @returns A BatchLPFees object uniquely identifying LP fees per unique input deposit.
   */
  async batchComputeLpFees(deposits: V3DepositWithBlock[]): Promise<BatchLPFees> {
    const { hubPoolClient } = this.clients;

    const _lpFees = await hubPoolClient.batchComputeRealizedLpFeePct(deposits);

    const lpFees: BatchLPFees = _lpFees.reduce((acc, { realizedLpFeePct: lpFeePct }, idx) => {
      const lpFeeRequest = deposits[idx];
      const { originChainId } = lpFeeRequest;
      const key = this.getLPFeeKey(lpFeeRequest);
      acc[key] ??= [];
      acc[key].push({ originChainId, lpFeePct });
      return acc;
    }, {});

    return lpFees;
  }

  protected async executeFills(chainId: number, simulate = false): Promise<string[]> {
    const {
      pendingTxnReceipts,
      clients: { multiCallerClient },
    } = this;

    if (isDefined(pendingTxnReceipts[chainId])) {
      this.logger.info({
        at: "Relayer::executeFills",
        message: `${getNetworkName(chainId)} transaction queue has pending fills; skipping...`,
      });
      multiCallerClient.clearTransactionQueue(chainId);
      return [];
    }
    pendingTxnReceipts[chainId] = multiCallerClient.executeTxnQueue(chainId, simulate);
    const txnReceipts = await pendingTxnReceipts[chainId];
    delete pendingTxnReceipts[chainId];

    return txnReceipts.map(({ hash }) => hash);
  }

  async checkForUnfilledDepositsAndFill(
    simulate = false
  ): Promise<{ [chainId: number]: Promise<string[]> }> {
    const { hubPoolClient, profitClient, spokePoolClients, tokenClient, multiCallerClient } = this.clients;

    // Fetch the average block time for mainnet, for later use in evaluating quoteTimestamps.
    this.hubPoolBlockBuffer ??= Math.ceil(
      HUB_SPOKE_BLOCK_LAG * (await sdkUtils.averageBlockTime(hubPoolClient.hubPool.provider)).average
    );

    // Flush any pre-existing enqueued transactions that might not have been executed.
    multiCallerClient.clearTransactionQueue();
    const txnReceipts: { [chainId: number]: Promise<string[]> } = Object.fromEntries(
      Object.values(spokePoolClients).map(({ chainId }) => [chainId, []])
    );

    // Fetch unfilled deposits and filter out deposits upfront before we compute the minimum deposit confirmation
    // per chain, which is based on the deposit volume we could fill.
    const unfilledDeposits = this._getUnfilledDeposits();
    const allUnfilledDeposits = Object.values(unfilledDeposits)
      .flat()
      .map(({ deposit }) => deposit);

    if (!this.config.externalIndexer || allUnfilledDeposits.length > 0) {
      this.logger.debug({
        at: "Relayer::checkForUnfilledDepositsAndFill",
        message: `${allUnfilledDeposits.length} deposits found.`,
      });
    }
    if (allUnfilledDeposits.length === 0) {
      return txnReceipts;
    }

    // const lpFees = await this.batchComputeLpFees(allUnfilledDeposits);
    await sdkUtils.forEachAsync(Object.entries(unfilledDeposits), async ([chainId, _deposits]) => {
      if (_deposits.length === 0) {
        return;
      }

      const destinationChainId = Number(chainId);
      const deposits = _deposits.map(({ deposit }) => deposit);
      const unfilledDeposits = [];
      for (const deposit of deposits) {
        const fillStatus = await sdkUtils.relayFillStatus(spokePoolClients[destinationChainId].spokePool, deposit);
        if (fillStatus !== FillStatus.Filled) {
          unfilledDeposits.push(deposit);
        }
      };

      await this.evaluateFills(unfilledDeposits, this.config.repaymentChainId);

      if (multiCallerClient.getQueuedTransactions(destinationChainId).length > 0) {
        txnReceipts[destinationChainId] = this.executeFills(destinationChainId, simulate);
      }
    });

    // If during the execution run we had shortfalls or unprofitable fills then handle it by producing associated logs.
    if (tokenClient.anyCapturedShortFallFills()) {
      this.handleTokenShortfall();
    }
    if (profitClient.anyCapturedUnprofitableFills()) {
      this.handleUnprofitableFill();
    }

    return txnReceipts;
  }

  requestSlowFill(deposit: V3Deposit): void {
    // don't request slow fill if origin/destination chain is a lite chain
    if (deposit.fromLiteChain || deposit.toLiteChain) {
      this.logger.debug({
        at: "Relayer::requestSlowFill",
        message: "Prevent requesting slow fill request to/from lite chain.",
        deposit,
      });
      return;
    }

    // Verify that the _original_ message was empty, since that's what would be used in a slow fill. If a non-empty
    // message was nullified by an update, it can be full-filled but preferably not automatically zero-filled.
    if (!isMessageEmpty(deposit.payload)) {
      this.logger.warn({
        at: "Relayer::requestSlowFill",
        message: "Suppressing slow fill request for deposit with message.",
        deposit,
      });
      return;
    }

    const { hubPoolClient, spokePoolClients, multiCallerClient } = this.clients;
    const { originChainId, destinationChainId, intentOwner, nonce, outputToken } = deposit;
    const spokePoolClient = spokePoolClients[destinationChainId];
    const slowFillRequest = spokePoolClient.getSlowFillRequest(deposit);
    if (isDefined(slowFillRequest)) {
      return; // Slow fill has already been requested; nothing to do.
    }

    const formatSlowFillRequestMarkdown = (): string => {
      const { symbol, decimals } = hubPoolClient.getTokenInfo(destinationChainId, outputToken);
      const formatter = createFormatFunction(2, 4, false, decimals);
      const outputAmount = formatter(deposit.outputAmount);
      const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];

      // @todo (future) infer the updated outputAmount by zeroing the relayer fee in order to print the correct amount.
      return (
        `Requested slow fill 🐌 of ${outputAmount} ${symbol}` +
        ` on ${dstChain} for ${srcChain} depositor ${intentOwner} with nonce ${nonce}.`
      );
    };

    this.logger.debug({ at: "Relayer::requestSlowFill", message: "Enqueuing slow fill request.", deposit });
    multiCallerClient.enqueueTransaction({
      chainId: destinationChainId,
      contract: spokePoolClient.spokePool,
      method: "requestV3SlowFill",
      args: [deposit],
      message: "Requested slow fill for deposit.",
      mrkdwn: formatSlowFillRequestMarkdown(),
    });
  }

  fillRelay(deposit: V3Deposit, repaymentChainId: number, realizedLpFeePct: BigNumber, refundRecipient: string, l2Recipient: string, gasLimit?: BigNumber): void {
    const { spokePoolClients, multiCallerClient } = this.clients;
    this.logger.debug({
      at: "Relayer::fillRelay",
      message: `Filling v3 depositor ${deposit.intentOwner} with nonce ${deposit.nonce} with repayment on ${repaymentChainId}.`,
      deposit,
      repaymentChainId,
      realizedLpFeePct,
    });

    const l2TxGasLimit = gasLimit ?? ethersUtils.parseUnits("2000000", "wei");
    const l2GasPerPubdataByteLimit = ethersUtils.parseUnits("800", "wei");
    // const value = ethersUtils.parseEther("0.0005");

    const [method, args] = ["fillIntent", [deposit, repaymentChainId, l2TxGasLimit, l2GasPerPubdataByteLimit, refundRecipient, l2Recipient]];
    const message = `Filled v3 deposit 🚀`;
    const mrkdwn = this.constructRelayFilledMrkdwn(deposit, repaymentChainId, realizedLpFeePct);
    const contract = spokePoolClients[deposit.destinationChainId].spokePool;
    const chainId = deposit.destinationChainId;
    multiCallerClient.enqueueTransaction({ contract, chainId, method, args, gasLimit, message, mrkdwn });
  }

  private handleTokenShortfall() {
    const tokenShortfall = this.clients.tokenClient.getTokenShortfall();

    let mrkdwn = "";
    Object.entries(tokenShortfall).forEach(([_chainId, shortfallForChain]) => {
      const chainId = Number(_chainId);
      mrkdwn += `*Shortfall on ${getNetworkName(chainId)}:*\n`;
      Object.entries(shortfallForChain).forEach(([token, { shortfall, balance, needed, deposits }]) => {
        const { symbol, formatter } = this.formatAmount(chainId, token);
        mrkdwn +=
          ` - ${symbol} cumulative shortfall of ` +
          `${formatter(shortfall.toString())} ` +
          `(have ${formatter(balance.toString())} but need ` +
          `This is blocking deposits: ${deposits}.\n`;
      });
    });

    this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
      at: "Relayer::handleTokenShortfall",
      message: "Insufficient balance to fill all deposits 💸!",
      mrkdwn,
    });
  }

  private formatAmount(
    chainId: number,
    tokenAddress: string
  ): { symbol: string; decimals: number; formatter: (amount: string) => string } {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForAddress(tokenAddress, chainId);
    return { symbol, decimals, formatter: createFormatFunction(2, 4, false, decimals) };
  }

  private handleUnprofitableFill() {
    const { profitClient } = this.clients;
    const unprofitableDeposits = profitClient.getUnprofitableFills();

    let mrkdwn = "";
    Object.keys(unprofitableDeposits).forEach((chainId) => {
      let depositMrkdwn = "";
      Object.keys(unprofitableDeposits[chainId]).forEach((idx) => {
        const { deposit, lpFeePct, relayerFeePct, gasCost } = unprofitableDeposits[chainId][idx];

        // Skip notifying if the unprofitable fill happened too long ago to avoid spamming.
        if (deposit.quoteTimestamp + UNPROFITABLE_DEPOSIT_NOTICE_PERIOD < getCurrentTime()) {
          return;
        }

        const { originChainId, destinationChainId, inputToken, outputToken, inputAmount, outputAmount } = deposit;
        const depositblockExplorerLink = blockExplorerLink(deposit.transactionHash, originChainId);
        const { symbol: inputSymbol, formatter: inputFormatter } = this.formatAmount(originChainId, inputToken);
        const formattedInputAmount = inputFormatter(inputAmount.toString());
        const { symbol: outputSymbol, formatter: outputFormatter } = this.formatAmount(destinationChainId, outputToken);
        const formattedOutputAmount = outputFormatter(outputAmount.toString());

        const { symbol: gasTokenSymbol, decimals: gasTokenDecimals } = profitClient.resolveGasToken(destinationChainId);
        const formattedGasCost = createFormatFunction(2, 10, false, gasTokenDecimals)(gasCost.toString());
        const formattedRelayerFeePct = formatFeePct(relayerFeePct);
        const formattedLpFeePct = formatFeePct(lpFeePct);

        depositMrkdwn +=
          `- Depositor ${deposit.depositor} with Nonce ${deposit.nonce} (tx: ${depositblockExplorerLink})` +
          ` of input amount ${formattedInputAmount} ${inputSymbol}` +
          ` and output amount ${formattedOutputAmount} ${outputSymbol}` +
          ` from ${getNetworkName(originChainId)} to ${getNetworkName(destinationChainId)}` +
          ` with relayerFeePct ${formattedRelayerFeePct}%, lpFeePct ${formattedLpFeePct}%,` +
          ` and gas cost ${formattedGasCost} ${gasTokenSymbol} is unprofitable!\n`;
      });

      if (depositMrkdwn) {
        mrkdwn += `*Unprofitable deposits on ${getNetworkName(chainId)}:*\n` + depositMrkdwn;
      }
    });

    if (mrkdwn) {
      this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
        at: "Relayer::handleUnprofitableFill",
        message: "Not relaying unprofitable deposits 🙅‍♂️!",
        mrkdwn,
      });
    }
  }

  private constructRelayFilledMrkdwn(
    deposit: V3Deposit,
    repaymentChainId: number,
    realizedLpFeePct: BigNumber
  ): string {
    let mrkdwn =
      this.constructBaseFillMarkdown(deposit, realizedLpFeePct) +
      ` Relayer repayment: ${getNetworkName(repaymentChainId)}.`;

    if (isDepositSpedUp(deposit)) {
      const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfo(
        deposit.destinationChainId,
        deposit.outputToken
      );
      const updatedOutputAmount = createFormatFunction(2, 4, false, decimals)(deposit.updatedOutputAmount.toString());
      mrkdwn += ` Reduced output amount: ${updatedOutputAmount} ${symbol}.`;
    }

    return mrkdwn;
  }

  private constructBaseFillMarkdown(deposit: V3Deposit, _realizedLpFeePct: BigNumber): string {
    const srcChain = getNetworkName(deposit.originChainId);
    const dstChain = getNetworkName(deposit.destinationChainId);
    const depositor = blockExplorerLink(deposit.intentOwner, deposit.originChainId);
    const inputAmount = createFormatFunction(2, 4, false, 18)(deposit.inputAmount.toString());

    let msg = `Relayed depositor ${deposit.intentOwner} with nonce ${deposit.nonce} from ${srcChain} to ${dstChain} of ${inputAmount} USDC`;
    const realizedLpFeePct = formatFeePct(_realizedLpFeePct);
    const _totalFeePct = deposit.inputAmount
      .sub(deposit.outputAmount)
      .mul(fixedPointAdjustment)
      .div(deposit.inputAmount);
    const totalFeePct = formatFeePct(_totalFeePct);
    const { symbol: outputTokenSymbol, decimals: outputTokenDecimals } =
      this.clients.hubPoolClient.getTokenInfoForAddress(deposit.outputToken, deposit.destinationChainId);
    const _outputAmount = createFormatFunction(2, 4, false, outputTokenDecimals)(deposit.outputAmount.toString());
    msg +=
      ` and output ${_outputAmount} ${outputTokenSymbol}, with depositor ${depositor}.` +
      ` Realized LP fee: ${realizedLpFeePct}%, total fee: ${totalFeePct}%.`;

    return msg;
  }
}
