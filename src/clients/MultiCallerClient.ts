import { utils as sdkUtils } from "@across-protocol/sdk";
import {
  winston,
  getNetworkName,
  isPromiseFulfilled,
  getTarget,
  TransactionResponse,
  TransactionSimulationResult,
  Contract,
  Signer,
  getProvider,
} from "../utils";
import { AugmentedTransaction, TransactionClient } from "./TransactionClient";

// @todo: MultiCallerClient should be generic. For future, permit the class instantiator to supply their own
// set of known failures that can be suppressed/ignored.
// Use this list of Smart Contract revert reasons to filter out transactions that revert in the
// Multicaller client's simulations but that we can ignore. Check for exact revert reason instead of using
// .includes() to partially match reason string in order to not ignore errors thrown by non-contract reverts.
// For example, a NodeJS error might result in a reason string that includes more than just the contract revert reason.
export const knownRevertReasons = new Set([
  "nonce has already been used",
  "replacement fee too low",
  "relay filled",
  "Already claimed",
  "RelayFilled",
  "ClaimedMerkleLeaf",
  "InvalidSlowFillRequest",
]);

// The following reason potentially includes false positives of reverts that we should be alerted on, however
// there is something likely broken in how the provider is interpreting contract reverts. Currently, there are
// a lot of duplicate transaction sends that are reverting with this reason, for example, sending a transaction
// to execute a relayer refund leaf takes a while to execute and ends up reverting because a duplicate transaction
// mines before it. This situation leads to this revert reason which is spamming the Logger currently.
export const unknownRevertReasons = [
  "missing revert data in call exception; Transaction reverted without a reason string",
  "execution reverted",
];
export const unknownRevertReasonMethodsToIgnore = new Set([
  "multicall",
  "fillRelay",
  "fillRelayWithUpdatedFee",
  "fillV3Relay",
  "fillV3RelayWithUpdatedDeposit",
  "requestV3SlowFill",
  "executeV3SlowRelayLeaf",
  "executeSlowRelayLeaf",
  "executeRelayerRefundLeaf",
  "executeRootBundle",
]);

// @dev The dataworker executor personality typically bundles an Optimism L1 deposit via multicall3 aggregate(). Per
//      Optimism's Bedrock migration, gas estimates should be padded by 50% to ensure that transactions do not fail
//      with OoG. Because we optimistically construct an aggregate() transaction without simulating each simulating
//      each transaction, we do not know the gas cost of each bundled transaction. Therefore, pad the resulting
//      gasLimit. This can admittedly pad the gasLimit by a lot more than is required.
//      See also https://community.optimism.io/docs/developers/bedrock/differences/
const MULTICALL3_AGGREGATE_GAS_MULTIPLIER = 1.5;

export class MultiCallerClient {
  protected txnClient: TransactionClient;
  protected txns: { [chainId: number]: AugmentedTransaction[] } = {};
  protected valueTxns: { [chainId: number]: AugmentedTransaction[] } = {};
  constructor(
    readonly logger: winston.Logger,
    readonly chunkSize: { [chainId: number]: number } = {},
    readonly baseSigner?: Signer
  ) {
    this.txnClient = new TransactionClient(logger);
  }

  getQueuedTransactions(chainId: number): AugmentedTransaction[] {
    const allTxns = [];
    if (this.valueTxns?.[chainId]) {
      allTxns.push(...this.valueTxns[chainId]);
    }
    if (this.txns?.[chainId]) {
      allTxns.push(...this.txns[chainId]);
    }
    return allTxns;
  }

  // Adds all information associated with a transaction to the transaction queue.
  enqueueTransaction(txn: AugmentedTransaction): void {
    // Value transactions are sorted immediately because the UMA multicall implementation rejects them.
    const txnQueue = txn.value && txn.value.gt(0) ? this.valueTxns : this.txns;
    if (txnQueue[txn.chainId] === undefined) {
      txnQueue[txn.chainId] = [];
    }
    txnQueue[txn.chainId].push(txn);
  }

  transactionCount(): number {
    return Object.values(this.txns)
      .concat(Object.values(this.valueTxns))
      .reduce((count, txnQueue) => (count += txnQueue.length), 0);
  }

  clearTransactionQueue(chainId: number | null = null): void {
    if (chainId !== null) {
      this.txns[chainId] = [];
      this.valueTxns[chainId] = [];
    } else {
      this.txns = {};
      this.valueTxns = {};
    }
  }

  // For each chain, collate the enqueued transactions and process them in parallel.
  async executeTxnQueues(simulate = false, chainIds: number[] = []): Promise<Record<number, string[]>> {
    if (chainIds.length === 0) {
      chainIds = sdkUtils.dedupArray([
        ...Object.keys(this.valueTxns).map(Number),
        ...Object.keys(this.txns).map(Number),
      ]);
    }

    const results = await Promise.allSettled(chainIds.map((chainId) => this.executeTxnQueue(chainId, simulate)));

    // Collate the results for each chain.
    const txnHashes: Record<number, { result: string[]; isError: boolean }> = Object.fromEntries(
      results.map((result, idx) => {
        const chainId = chainIds[idx];
        if (isPromiseFulfilled(result)) {
          return [chainId, { result: result.value.map((txnResponse) => txnResponse.hash), isError: false }];
        } else {
          return [chainId, { result: result.reason, isError: true }];
        }
      })
    );

    // We need to iterate over the results to determine if any of the transactions failed.
    // If any of the transactions failed, we need to log the results and throw an error. However, we want to
    // only log the results once, so we need to collate the results into a single object.
    const failedChains = Object.entries(txnHashes)
      .filter(([, { isError }]) => isError)
      .map(([chainId]) => chainId);
    if (failedChains.length > 0) {
      // Log the results.
      this.logger.error({
        at: "MultiCallerClient#executeTxnQueues",
        message: `Failed to execute ${failedChains.length} transaction(s) on chain(s) ${failedChains.join(", ")}`,
        error: failedChains.map((chainId) => txnHashes[chainId].result),
      });
      throw new Error(
        `Failed to execute ${failedChains.length} transaction(s) on chain(s) ${failedChains.join(
          ", "
        )}: ${JSON.stringify(txnHashes)}`
      );
    }
    // Recombine the results into a single object that match the legacy implementation.
    return Object.fromEntries(Object.entries(txnHashes).map(([chainId, { result }]) => [chainId, result]));
  }

  // For a single chain, take any enqueued transactions and attempt to execute them.
  async executeTxnQueue(chainId: number, simulate = false): Promise<TransactionResponse[]> {
    const txns: AugmentedTransaction[] | undefined = this.txns[chainId];
    const valueTxns: AugmentedTransaction[] | undefined = this.valueTxns[chainId];
    this.clearTransactionQueue(chainId);
    return this._executeTxnQueue(chainId, txns, valueTxns, simulate);
  }

  // For a single chain, simulate all potential multicall txns and group the ones that pass into multicall bundles.
  // Then, submit a concatenated list of value txns + multicall bundles. If simulation was requested, log the results
  // and return early.
  protected async _executeTxnQueue(
    chainId: number,
    txns: AugmentedTransaction[] = [],
    valueTxns: AugmentedTransaction[] = [],
    simulate = false
  ): Promise<TransactionResponse[]> {
    const nTxns = txns.length + valueTxns.length;
    if (nTxns === 0) {
      return [];
    }

    const networkName = getNetworkName(chainId);
    this.logger.debug({
      at: "MultiCallerClient#executeTxnQueue",
      message: `${simulate ? "Simulating" : "Executing"} ${nTxns} transaction(s) on ${networkName}.`,
    });

    const txnRequestsToSubmit: AugmentedTransaction[] = [];
    const individualTxnSimResults = await Promise.allSettled([
      this.simulateTransactionQueue(txns),
      this.simulateTransactionQueue(valueTxns),
    ]);
    const [_txns, _valueTxns] = individualTxnSimResults.map((result): AugmentedTransaction[] => {
      return isPromiseFulfilled(result) ? result.value : [];
    });
    // Fill in the set of txns to submit to the network. Anything that failed simulation is dropped.
    txnRequestsToSubmit.push(..._valueTxns.concat(_txns));

    if (simulate) {
      let mrkdwn = "";
      txnRequestsToSubmit.forEach((txn, idx) => {
        mrkdwn += `  *${idx + 1}. ${txn.message || "No message"}: ${txn.mrkdwn || "No markdown"}\n`;
      });
      this.logger.debug({
        at: "MultiCallerClient#executeTxnQueue",
        message: `${txnRequestsToSubmit.length}/${nTxns} ${networkName} transaction simulation(s) succeeded!`,
        mrkdwn,
      });
      this.logger.debug({ at: "MulticallerClient#executeTxnQueue", message: "Exiting simulation mode 🎮" });
      return [];
    }

    const txnResponses: TransactionResponse[] =
      txnRequestsToSubmit.length > 0 ? await this.txnClient.submit(chainId, txnRequestsToSubmit) : [];

    return txnResponses;
  }

  async simulateTransactionQueue(transactions: AugmentedTransaction[]): Promise<AugmentedTransaction[]> {
    const validTxns: AugmentedTransaction[] = [];
    const invalidTxns: TransactionSimulationResult[] = [];

    // Simulate the transaction execution for the whole queue.
    const txnSimulations = await this.txnClient.simulate(transactions);
    txnSimulations.forEach((txn) => {
      if (txn.succeed) {
        validTxns.push(txn.transaction);
      } else {
        invalidTxns.push(txn);
      }
    });
    if (invalidTxns.length > 0) {
      this.logSimulationFailures(invalidTxns);
    }

    return validTxns;
  }

  // Ignore the general unknown revert reason for specific methods or uniformly ignore specific revert reasons for any
  // contract method. Note: Check for exact revert reason instead of using .includes() to partially match reason string
  // in order to not ignore errors thrown by non-contract reverts. For example, a NodeJS error might result in a reason
  // string that includes more than just the contract revert reason.
  protected canIgnoreRevertReason(txn: TransactionSimulationResult): boolean {
    const { transaction: _txn, reason } = txn;
    const lowerCaseReason = reason.toLowerCase();
    const knownReason = [...knownRevertReasons].some((knownReason) =>
      lowerCaseReason.includes(knownReason.toLowerCase())
    );
    return (
      knownReason ||
      (unknownRevertReasonMethodsToIgnore.has(_txn.method) &&
        unknownRevertReasons.some((_reason) => lowerCaseReason.includes(_reason.toLowerCase())))
    );
  }

  // Filter out transactions that revert for non-critical, expected reasons. For example, the "relay filled" error may
  // will occur frequently if there are multiple relayers running at the same time. Similarly, the "already claimed"
  // error will occur if there are overlapping dataworker executor runs.
  // @todo: Figure out a less hacky way to reduce these errors rather than ignoring them.
  // @todo: Consider logging key txn information with the failures?
  protected logSimulationFailures(failures: TransactionSimulationResult[]): void {
    const ignoredFailures: TransactionSimulationResult[] = [];
    const loggedFailures: TransactionSimulationResult[] = [];

    failures.forEach((failure) => {
      (this.canIgnoreRevertReason(failure) ? ignoredFailures : loggedFailures).push(failure);
    });

    if (ignoredFailures.length > 0) {
      this.logger.debug({
        at: "MultiCallerClient#LogSimulationFailures",
        message: `Filtering out ${ignoredFailures.length} transactions with revert reasons we can ignore.`,
        revertReasons: ignoredFailures.map((txn) => txn.reason),
      });
    }

    // Log unexpected/noteworthy failures.
    if (loggedFailures.length > 0) {
      this.logger.error({
        at: "MultiCallerClient#LogSimulationFailures",
        message: `${loggedFailures.length} in the queue may revert!`,
        revertingTransactions: loggedFailures.map((txn) => {
          return {
            target: getTarget(txn.transaction.contract.address),
            args: txn.transaction.args,
            reason: txn.reason,
            message: txn.transaction.message,
            mrkdwn: txn.transaction.mrkdwn,
          };
        }),
        notificationPath: "across-error",
      });
    }
  }
}
