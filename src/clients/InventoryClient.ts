import { constants, utils as sdkUtils } from "@across-protocol/sdk";
import {
  bnZero,
  BigNumber,
  winston,
  getNetworkName,
  createFormatFunction,
  blockExplorerLink,
  Contract,
  runTransaction,
  isDefined,
  DefaultLogLevels,
  TransactionResponse,
  AnyObject,
  ERC20,
  TOKEN_SYMBOLS_MAP,
  assert,
  compareAddressesSimple,
  getUsdcSymbol,
} from "../utils";
import { HubPoolClient, TokenClient } from ".";
import { V3Deposit } from "../interfaces";
import { InventoryConfig, isAliasConfig, TokenBalanceConfig } from "../interfaces/InventoryManagement";
import lodash from "lodash";

type TokenDistribution = { [l2Token: string]: BigNumber };
type TokenDistributionPerL1Token = { [l1Token: string]: { [chainId: number]: TokenDistribution } };

export type Rebalance = {
  chainId: number;
  l1Token: string;
  l2Token: string;
  thresholdPct: BigNumber;
  targetPct: BigNumber;
  currentAllocPct: BigNumber;
  balance: BigNumber;
  cumulativeBalance: BigNumber;
  amount: BigNumber;
};

const { CHAIN_IDs } = constants;

export class InventoryClient {
  private logDisabledManagement = false;
  private readonly scalar: BigNumber;
  private readonly formatWei: ReturnType<typeof createFormatFunction>;

  constructor(
    readonly relayer: string,
    readonly logger: winston.Logger,
    readonly inventoryConfig: InventoryConfig,
    readonly tokenClient: TokenClient,
    readonly chainIdList: number[],
    readonly hubPoolClient: HubPoolClient,
    readonly simMode = false,
    readonly prioritizeLpUtilization = true
  ) {
    this.scalar = sdkUtils.fixedPointAdjustment;
    this.formatWei = createFormatFunction(2, 4, false, 18);
  }

  /**
   * Resolve the token balance configuration for `l1Token` on `chainId`. If `l1Token` maps to multiple tokens on
   * `chainId` then `l2Token` must be supplied.
   * @param l1Token L1 token address to query.
   * @param chainId Chain ID to query on
   * @param l2Token Optional L2 token address when l1Token maps to multiple l2Token addresses.
   */
  getTokenConfig(l1Token: string, chainId: number, l2Token?: string): TokenBalanceConfig | undefined {
    const tokenConfig = this.inventoryConfig.tokenConfig[l1Token];
    assert(isDefined(tokenConfig), `getTokenConfig: No token config found for ${l1Token}.`);

    if (isAliasConfig(tokenConfig)) {
      assert(isDefined(l2Token), `Cannot resolve ambiguous ${getNetworkName(chainId)} token config for ${l1Token}`);
      return tokenConfig[l2Token]?.[chainId];
    } else {
      return tokenConfig[chainId];
    }
  }

  /*
   * Get the total balance for an L1 token across all chains, considering any outstanding cross chain transfers as a
   * virtual balance on that chain.
   * @param l1Token L1 token address to query.
   * returns Cumulative balance of l1Token across all inventory-managed chains.
   */
  getCumulativeBalance(l1Token: string): BigNumber {
    return this.getEnabledChains()
      .map((chainId) => this.getBalanceOnChain(chainId, l1Token))
      .reduce((acc, curr) => acc.add(curr), bnZero);
  }

  /**
   * Determine the effective/virtual balance of an l1 token that has been deployed to another chain.
   * Includes both the actual balance on the chain and any pending inbound transfers to the target chain.
   * If l2Token is supplied, return its balance on the specified chain. Otherwise, return the total allocation
   * of l1Token on the specified chain.
   * @param chainId Chain to query token balance on.
   * @param l1Token L1 token to query on chainId (after mapping).
   * @param l2Token Optional l2 token address to narrow the balance reporting.
   * @returns Balance of l1Token on chainId.
   */
  getBalanceOnChain(chainId: number, l1Token: string, l2Token?: string): BigNumber {
    const { tokenClient } = this;
    let balance: BigNumber;

    // Return the balance for a specific l2 token on the remote chain.
    if (isDefined(l2Token)) {
      return tokenClient.getBalance(chainId, l2Token);
    }

    const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
    return l2Tokens
      .map((l2Token) => tokenClient.getBalance(chainId, l2Token))
      .reduce((acc, curr) => acc.add(curr), bnZero);
  }

  /**
   * Determine the allocation of an l1 token across all configured remote chain IDs.
   * @param l1Token L1 token to query.
   * @returns Distribution of l1Token by chain ID and l2Token.
   */
  getChainDistribution(l1Token: string): { [chainId: number]: TokenDistribution } {
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    const distribution: { [chainId: number]: TokenDistribution } = {};

    this.getEnabledChains().forEach((chainId) => {
      // If token doesn't have entry on chain, skip creating an entry for it since we'll likely run into an error
      // later trying to grab the chain equivalent of the L1 token via the HubPoolClient.
      if (chainId === this.hubPoolClient.chainId || this._l1TokenEnabledForChain(l1Token, chainId)) {
        if (cumulativeBalance.eq(bnZero)) {
          return;
        }

        distribution[chainId] ??= {};
        const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
        l2Tokens.forEach((l2Token) => {
          // The effective balance is the current balance + inbound bridge transfers.
          const effectiveBalance = this.getBalanceOnChain(chainId, l1Token, l2Token);
          distribution[chainId][l2Token] = effectiveBalance.mul(this.scalar).div(cumulativeBalance);
        });
      }
    });
    return distribution;
  }

  /**
   * Determine the allocation of an l1 token across all configured remote chain IDs.
   * @param l1Token L1 token to query.
   * @returns Distribution of l1Token by chain ID and l2Token.
   */
  getTokenDistributionPerL1Token(): TokenDistributionPerL1Token {
    const distributionPerL1Token: TokenDistributionPerL1Token = {};
    this.getL1Tokens().forEach((l1Token) => (distributionPerL1Token[l1Token] = this.getChainDistribution(l1Token)));
    return distributionPerL1Token;
  }

  // Get the balance of a given token on a given chain, including shortfalls and any pending cross chain transfers.
  getCurrentAllocationPct(l1Token: string, chainId: number, l2Token: string): BigNumber {
    // If there is nothing over all chains, return early.
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    if (cumulativeBalance.eq(bnZero)) {
      return bnZero;
    }

    const shortfall = this.tokenClient.getShortfallTotalRequirement(chainId, l2Token);
    const currentBalance = this.getBalanceOnChain(chainId, l1Token, l2Token).sub(shortfall);

    // Multiply by scalar to avoid rounding errors.
    return currentBalance.mul(this.scalar).div(cumulativeBalance);
  }

  getRepaymentTokenForL1Token(l1Token: string, chainId: number | string): string | undefined {
    // @todo: Update HubPoolClient.getL2TokenForL1TokenAtBlock() such that it returns `undefined` instead of throwing.
    try {
      return this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, Number(chainId));
    } catch {
      return undefined;
    }
  }

  /**
   * From an L1Token and remote chain ID, resolve all supported corresponding tokens.
   * This should include at least the relevant repayment token on the relevant chain, but may also include other
   * "equivalent" tokens (i.e. as with Bridged & Native USDC).
   * @param l1Token Mainnet token to query.
   * @param chainId Remove chain to query.
   * @returns An array of supported tokens on chainId that map back to l1Token on mainnet.
   */
  getRemoteTokensForL1Token(l1Token: string, chainId: number | string): string[] {
    if (chainId === this.hubPoolClient.chainId) {
      return [l1Token];
    }

    const tokenConfig = this.inventoryConfig.tokenConfig[l1Token];

    if (isAliasConfig(tokenConfig)) {
      return Object.keys(tokenConfig).filter((k) => isDefined(tokenConfig[k][chainId]));
    }

    const destinationToken = this.getRepaymentTokenForL1Token(l1Token, chainId);
    if (!isDefined(destinationToken)) {
      return [];
    }

    return [destinationToken];
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    const hubPoolChainId = this.hubPoolClient.chainId;
    return this.getEnabledChains().filter((chainId) => chainId !== hubPoolChainId);
  }

  getL1Tokens(): string[] {
    return (
      Object.keys(this.inventoryConfig.tokenConfig ?? {}) ||
      this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address)
    );
  }

  /**
   * Returns true if the depositor-specified output token is supported by the this inventory client.
   * @param deposit V3 Deposit to consider
   * @returns boolean True if output and input tokens are equivalent or if input token is USDC and output token
   * is Bridged USDC.
   */
  validateOutputToken(deposit: V3Deposit): boolean {
    const { inputToken, outputToken, originChainId, destinationChainId } = deposit;

    // Return true if input and output tokens are mapped to the same L1 token via PoolRebalanceRoutes
    const equivalentTokens = this.hubPoolClient.areTokensEquivalent(
      inputToken,
      originChainId,
      outputToken,
      destinationChainId
    );
    if (equivalentTokens) {
      return true;
    }

    // Return true if input token is Native USDC token and output token is Bridged USDC or if input token
    // is Bridged USDC and the output token is Native USDC.
    // @dev getUsdcSymbol() returns defined if the token on the origin chain is either USDC, USDC.e or USDbC.
    // The contracts should only allow deposits where the input token is the Across-supported USDC variant, so this
    // check specifically handles the case where the input token is Bridged/Native and the output token Native/Bridged.
    const isInputTokenUSDC = isDefined(getUsdcSymbol(inputToken, originChainId));
    const isOutputTokenBridgedUSDC = compareAddressesSimple(
      outputToken,
      TOKEN_SYMBOLS_MAP[destinationChainId === CHAIN_IDs.BASE ? "USDbC" : "USDC.e"].addresses?.[destinationChainId]
    );
    return isInputTokenUSDC && isOutputTokenBridgedUSDC;
  }

  getPossibleRebalances(): Rebalance[] {
    const chainIds = this.getEnabledL2Chains();
    const rebalancesRequired: Rebalance[] = [];

    for (const l1Token of this.getL1Tokens()) {
      const cumulativeBalance = this.getCumulativeBalance(l1Token);
      if (cumulativeBalance.eq(bnZero)) {
        continue;
      }

      chainIds.forEach((chainId) => {
        // Skip if there's no configuration for l1Token on chainId.
        if (!this._l1TokenEnabledForChain(l1Token, chainId)) {
          return;
        }

        const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
        l2Tokens.forEach((l2Token) => {
          const currentAllocPct = this.getCurrentAllocationPct(l1Token, chainId, l2Token);
          const tokenConfig = this.getTokenConfig(l1Token, chainId, l2Token);
          const { thresholdPct, targetPct } = tokenConfig;

          if (currentAllocPct.gte(thresholdPct)) {
            return;
          }

          const deltaPct = targetPct.sub(currentAllocPct);
          const amount = deltaPct.mul(cumulativeBalance).div(this.scalar);
          const balance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);
          rebalancesRequired.push({
            chainId,
            l1Token,
            l2Token,
            currentAllocPct,
            thresholdPct,
            targetPct,
            balance,
            cumulativeBalance,
            amount,
          });
        });
      });
    }

    return rebalancesRequired;
  }

  // Trigger a rebalance if the current balance on any L2 chain, including shortfalls, is less than the threshold
  // allocation.
  async rebalanceInventoryIfNeeded(): Promise<void> {
    // Note: these types are just used inside this method, so they are declared in-line.
    type ExecutedRebalance = Rebalance & { hash: string };

    const possibleRebalances: Rebalance[] = [];
    const unexecutedRebalances: Rebalance[] = [];
    const executedTransactions: ExecutedRebalance[] = [];
    try {
      if (!this.isInventoryManagementEnabled()) {
        return;
      }
      const tokenDistributionPerL1Token = this.getTokenDistributionPerL1Token();
      this.constructConsideringRebalanceDebugLog(tokenDistributionPerL1Token);

      const rebalancesRequired = this.getPossibleRebalances();
      if (rebalancesRequired.length === 0) {
        this.log("No rebalances required");
        return;
      }

      // Next, evaluate if we have enough tokens on L1 to actually do these rebalances.
      for (const rebalance of rebalancesRequired) {
        const { balance, amount, l1Token, l2Token, chainId } = rebalance;

        // This is the balance left after any assumed rebalances from earlier loop iterations.
        const unallocatedBalance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);

        // If the amount required in the rebalance is less than the total amount of this token on L1 then we can execute
        // the rebalance to this particular chain. Note that if the sum of all rebalances required exceeds the l1
        // balance then this logic ensures that we only fill the first n number of chains where we can.
        if (amount.lte(unallocatedBalance)) {
          // As a precautionary step before proceeding, check that the token balance for the token we're about to send
          // hasn't changed on L1. It's possible its changed since we updated the inventory due to one or more of the
          // RPC's returning slowly, leading to concurrent/overlapping instances of the bot running.
          const tokenContract = new Contract(l1Token, ERC20.abi, this.hubPoolClient.hubPool.signer);
          const currentBalance = await tokenContract.balanceOf(this.relayer);

          const balanceChanged = !balance.eq(currentBalance);
          const [message, log] = balanceChanged
            ? ["🚧 Token balance on mainnet changed, skipping rebalance", this.logger.warn]
            : ["Token balance in relayer on mainnet is as expected, sending cross chain transfer", this.logger.debug];
          log({ at: "InventoryClient", message, l1Token, l2Token, l2ChainId: chainId, balance, currentBalance });

          if (!balanceChanged) {
            possibleRebalances.push(rebalance);
          }
        } else {
          // Extract unexecutable rebalances for logging.
          unexecutedRebalances.push(rebalance);
        }
      }

      // Extract unexecutable rebalances for logging.

      this.log("Considered inventory rebalances", { rebalancesRequired, possibleRebalances });

      // Construct logs on the cross-chain actions executed.
      let mrkdwn = "";

      const groupedRebalances = lodash.groupBy(executedTransactions, "chainId");
      for (const [_chainId, rebalances] of Object.entries(groupedRebalances)) {
        const chainId = Number(_chainId);
        mrkdwn += `*Rebalances sent to ${getNetworkName(chainId)}:*\n`;
        for (const { l2Token, amount, targetPct, thresholdPct, cumulativeBalance, hash, chainId } of rebalances) {
          const tokenInfo = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
          if (!tokenInfo) {
            `InventoryClient::rebalanceInventoryIfNeeded no token info for L2 token ${l2Token} on chain ${chainId}`;
          }
          const { symbol, decimals } = tokenInfo;
          const formatter = createFormatFunction(2, 4, false, decimals);
          mrkdwn +=
            ` - ${formatter(amount.toString())} ${symbol} rebalanced. This meets target allocation of ` +
            `${this.formatWei(targetPct.mul(100).toString())}% (trigger of ` +
            `${this.formatWei(thresholdPct.mul(100).toString())}%) of the total ` +
            `${formatter(
              cumulativeBalance.toString()
            )} ${symbol} over all chains (ignoring hubpool repayments). This chain has a shortfall of ` +
            `${formatter(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString())} ${symbol} ` +
            `tx: ${blockExplorerLink(hash, this.hubPoolClient.chainId)}\n`;
        }
      }

      const groupedUnexecutedRebalances = lodash.groupBy(unexecutedRebalances, "chainId");
      for (const [_chainId, rebalances] of Object.entries(groupedUnexecutedRebalances)) {
        const chainId = Number(_chainId);
        mrkdwn += `*Insufficient amount to rebalance to ${getNetworkName(chainId)}:*\n`;
        for (const { l1Token, l2Token, balance, cumulativeBalance, amount } of rebalances) {
          const tokenInfo = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
          if (!tokenInfo) {
            throw new Error(
              `InventoryClient::rebalanceInventoryIfNeeded no token info for L2 token ${l2Token} on chain ${chainId}`
            );
          }
          const { symbol, decimals } = tokenInfo;
          const formatter = createFormatFunction(2, 4, false, decimals);
          const distributionPct = tokenDistributionPerL1Token[l1Token][chainId][l2Token].mul(100);
          mrkdwn +=
            `- ${symbol} transfer blocked. Required to send ` +
            `${formatter(amount.toString())} but relayer has ` +
            `${formatter(balance.toString())} on L1. There is currently ` +
            `${formatter(this.getBalanceOnChain(chainId, l1Token, l2Token).toString())} ${symbol} on ` +
            `${getNetworkName(chainId)} which is ` +
            `${this.formatWei(distributionPct.toString())}% of the total ` +
            `${formatter(cumulativeBalance.toString())} ${symbol}.` +
            " This chain's pending L1->L2 transfer amount is ";
        }
      }

      if (mrkdwn) {
        this.log("Executed Inventory rebalances 📒", { mrkdwn }, "info");
      }
    } catch (error) {
      this.log(
        "Something errored during inventory rebalance",
        { error, possibleRebalances, unexecutedRebalances, executedTransactions }, // include all info to help debugging.
        "error"
      );
    }
  }

  constructConsideringRebalanceDebugLog(distribution: TokenDistributionPerL1Token): void {
    const logData: {
      [symbol: string]: {
        [chainId: number]: {
          [l2TokenAddress: string]: {
            actualBalanceOnChain: string;
            virtualBalanceOnChain: string;
            outstandingTransfers: string;
            tokenShortFalls: string;
            proRataShare: string;
          };
        };
      };
    } = {};
    const cumulativeBalances: { [symbol: string]: string } = {};
    Object.entries(distribution).forEach(([l1Token, distributionForToken]) => {
      const tokenInfo = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
      if (tokenInfo === undefined) {
        throw new Error(
          `InventoryClient::constructConsideringRebalanceDebugLog info not found for L1 token ${l1Token}`
        );
      }
      const { symbol, decimals } = tokenInfo;
      const formatter = createFormatFunction(2, 4, false, decimals);
      cumulativeBalances[symbol] = formatter(this.getCumulativeBalance(l1Token).toString());
      logData[symbol] ??= {};

      Object.keys(distributionForToken).forEach((_chainId) => {
        const chainId = Number(_chainId);
        logData[symbol][chainId] ??= {};

        Object.entries(distributionForToken[chainId]).forEach(([l2Token, amount]) => {
          const balanceOnChain = this.getBalanceOnChain(chainId, l1Token, l2Token);
          const actualBalanceOnChain = this.tokenClient.getBalance(chainId, l2Token);
          logData[symbol][chainId][l2Token] = {
            actualBalanceOnChain: formatter(actualBalanceOnChain.toString()),
            virtualBalanceOnChain: formatter(balanceOnChain.toString()),
            outstandingTransfers: "",
            tokenShortFalls: formatter(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString()),
            proRataShare: this.formatWei(amount.mul(100).toString()) + "%",
          };
        });
      });
    });

    this.log("Considering rebalance", {
      tokenDistribution: logData,
      cumulativeBalances,
      inventoryConfig: this.inventoryConfig,
    });
  }

  isInventoryManagementEnabled(): boolean {
    if (this?.inventoryConfig?.tokenConfig && Object.keys(this.inventoryConfig.tokenConfig).length > 0) {
      return true;
    }
    // Use logDisabledManagement to avoid spamming the logs on every check if this module is enabled.
    else if (this.logDisabledManagement == false) {
      this.log("Inventory Management Disabled");
    }
    this.logDisabledManagement = true;
    return false;
  }

  _l1TokenEnabledForChain(l1Token: string, chainId: number): boolean {
    const tokenConfig = this.inventoryConfig?.tokenConfig?.[l1Token];
    if (!isDefined(tokenConfig)) {
      return false;
    }

    // If tokenConfig directly references chainId, token is enabled.
    if (!isAliasConfig(tokenConfig) && isDefined(tokenConfig[chainId])) {
      return true;
    }

    // If any of the mapped symbols reference chainId, token is enabled.
    return Object.keys(tokenConfig).some((symbol) => isDefined(tokenConfig[symbol][chainId]));
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "InventoryClient", message, ...data });
    }
  }
}
