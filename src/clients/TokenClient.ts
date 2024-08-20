import { utils as sdkUtils } from "@across-protocol/sdk";
import { HubPoolClient, SpokePoolClient } from ".";
import { CachingMechanismInterface, L1Token, V3Deposit } from "../interfaces";
import {
  BigNumber,
  bnZero,
  Contract,
  ERC20,
  isDefined,
  MAX_SAFE_ALLOWANCE,
  MAX_UINT_VAL,
  assign,
  blockExplorerLink,
  getCurrentTime,
  getNetworkName,
  runTransaction,
  toBN,
  winston,
  getRedisCache,
} from "../utils";

export type TokenDataType = { [chainId: number]: { [token: string]: { balance: BigNumber; allowance: BigNumber } } };
type TokenShortfallType = {
  [chainId: number]: { [token: string]: { deposits: number[]; totalRequirement: BigNumber } };
};

export class TokenClient {
  tokenData: TokenDataType = {};
  tokenShortfall: TokenShortfallType = {};

  constructor(
    readonly logger: winston.Logger,
    readonly relayerAddress: string,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly hubpoolTokens: { [chainId: number]: [] }
  ) {}

  getAllTokenData(): TokenDataType {
    return this.tokenData;
  }

  getBalance(chainId: number, token: string): BigNumber {
    if (this.tokenData[chainId][token] === undefined) {
      return bnZero;
    }
    return this.tokenData[chainId][token].balance;
  }

  decrementLocalBalance(chainId: number, token: string, amount: BigNumber): void {
    this.tokenData[chainId][token].balance = this.tokenData[chainId][token].balance.sub(amount);
  }

  getShortfallTotalRequirement(chainId: number, token: string): BigNumber {
    return this.tokenShortfall?.[chainId]?.[token]?.totalRequirement ?? bnZero;
  }

  getTokensNeededToCoverShortfall(chainId: number, token: string): BigNumber {
    return this.getShortfallTotalRequirement(chainId, token).sub(this.getBalance(chainId, token));
  }

  getShortfallDeposits(chainId: number, token: string): number[] {
    return this.tokenShortfall?.[chainId]?.[token]?.deposits || [];
  }

  hasBalanceForFill(deposit: V3Deposit): boolean {
    return this.getBalance(deposit.destinationChainId, deposit.outputToken).gte(deposit.outputAmount);
  }

  // If the relayer tries to execute a relay but does not have enough tokens to fully fill it it will capture the
  // shortfall by calling this method. This will track the information for logging purposes and use in other clients.
  captureTokenShortfall(chainId: number, token: string, depositor: string, nonce: number, unfilledAmount: BigNumber): void {
    // Shortfall is the previous shortfall + the current unfilledAmount from this deposit.
    const totalRequirement = this.getShortfallTotalRequirement(chainId, token).add(unfilledAmount);

    // Deposits are the previous shortfall deposits, appended to this nonce.
    const deposits = [...this.getShortfallDeposits(chainId, token), depositor, nonce];
    assign(this.tokenShortfall, [chainId, token], { deposits, totalRequirement });
  }

  captureTokenShortfallForFill(deposit: V3Deposit): void {
    const { outputAmount: unfilledAmount } = deposit;
    this.logger.debug({ at: "TokenBalanceClient", message: "Handling token shortfall", deposit, unfilledAmount });
    this.captureTokenShortfall(deposit.destinationChainId, deposit.outputToken, deposit.intentOwner, deposit.nonce, unfilledAmount);
  }

  // Returns the total token shortfall the client has seen. Shortfall is defined as the difference between the total
  // requirement to send all seen relays and the total remaining balance of the relayer.
  getTokenShortfall(): {
    [chainId: number]: {
      [token: string]: { balance: BigNumber; needed: BigNumber; shortfall: BigNumber; deposits: number[] };
    };
  } {
    const tokenShortfall: {
      [chainId: number]: {
        [token: string]: { balance: BigNumber; needed: BigNumber; shortfall: BigNumber; deposits: number[] };
      };
    } = {};
    Object.entries(this.tokenShortfall).forEach(([_chainId, tokenMap]) => {
      const chainId = Number(_chainId);
      Object.entries(tokenMap).forEach(([token, { totalRequirement, deposits }]) =>
        assign(tokenShortfall, [chainId, token], {
          balance: this.getBalance(chainId, token),
          needed: totalRequirement,
          shortfall: this.getTokensNeededToCoverShortfall(chainId, token),
          deposits,
        })
      );
    });
    return tokenShortfall;
  }

  anyCapturedShortFallFills(): boolean {
    return Object.keys(this.tokenShortfall).length != 0;
  }

  clearTokenShortfall(): void {
    this.tokenShortfall = {};
  }

  clearTokenData(): void {
    this.tokenData = {};
  }

  async setOriginTokenApprovals(): Promise<void> {
    const tokensToApprove: { chainId: number; token: string }[] = [];
    Object.entries(this.tokenData).forEach(([_chainId, tokenMap]) => {
      const chainId = Number(_chainId);
      Object.entries(tokenMap).forEach(([token, { balance, allowance }]) => {
        if (balance.gt(bnZero) && allowance.lt(MAX_SAFE_ALLOWANCE)) {
          tokensToApprove.push({ chainId, token });
        }
      });
    });
    if (tokensToApprove.length === 0) {
      this.logger.debug({ at: "TokenBalanceClient", message: "All token approvals set for non-zero balances" });
      return;
    }

    let mrkdwn = "*Approval transactions:* \n";
    for (const { token, chainId } of tokensToApprove) {
      const targetSpokePool = this.spokePoolClients[chainId].spokePool;
      const contract = new Contract(token, ERC20.abi, targetSpokePool.signer);
      const tx = await runTransaction(this.logger, contract, "approve", [targetSpokePool.address, MAX_UINT_VAL]);
      mrkdwn +=
        ` - Approved SpokePool ${blockExplorerLink(targetSpokePool.address, chainId)} ` +
        `to spend ${await contract.symbol()} ${blockExplorerLink(token, chainId)} on ${getNetworkName(chainId)}. ` +
        `tx: ${blockExplorerLink(tx.hash, chainId)}\n`;
    }
    this.logger.info({ at: "TokenBalanceClient", message: "Approved whitelisted tokens! 💰", mrkdwn });
  }

  async setBondTokenAllowance(): Promise<void> {
    const { hubPool } = this.hubPoolClient;
    const { signer } = hubPool;
    const [_bondToken, ownerAddress] = await Promise.all([this._getBondToken(), signer.getAddress()]);
    const bondToken = new Contract(_bondToken, ERC20.abi, signer);

    const currentCollateralAllowance: BigNumber = await bondToken.allowance(ownerAddress, hubPool.address);
    if (currentCollateralAllowance.lt(toBN(MAX_SAFE_ALLOWANCE))) {
      const tx = await runTransaction(this.logger, bondToken, "approve", [hubPool.address, MAX_UINT_VAL]);
      const { chainId } = this.hubPoolClient;
      const mrkdwn =
        ` - Approved HubPool ${blockExplorerLink(hubPool.address, chainId)} ` +
        `to spend ${await bondToken.symbol()} ${blockExplorerLink(bondToken.address, chainId)}. ` +
        `tx ${blockExplorerLink(tx.hash, chainId)}\n`;
      this.logger.info({ at: "hubPoolClient", message: "Approved bond tokens! 💰", mrkdwn });
    } else {
      this.logger.debug({ at: "hubPoolClient", message: "Bond token approval set" });
    }
  }

  resolveRemoteTokens(chainId: number, hubPoolTokens: L1Token[]): Contract[] {
    const { signer } = this.spokePoolClients[chainId].spokePool;
    return hubPoolTokens.map(({ address }) => new Contract(address, ERC20.abi, signer));
  }

  async updateChain(
    chainId: number,
    hubPoolTokens: L1Token[]
  ): Promise<Record<string, { balance: BigNumber; allowance: BigNumber }>> {
    hubPoolTokens = this.hubpoolTokens[chainId];
    return this.fetchTokenData(chainId, hubPoolTokens);
  }

  async update(): Promise<void> {
    const start = getCurrentTime();
    this.logger.debug({ at: "TokenBalanceClient", message: "Updating TokenBalance client" });
    const { hubPoolClient } = this;

    const hubPoolTokens = hubPoolClient.getL1Tokens();
    const chainIds = Object.values(this.spokePoolClients).map(({ chainId }) => chainId);

    const balanceInfo = await Promise.all(
      chainIds
        .filter((chainId) => isDefined(this.spokePoolClients[chainId]))
        .map((chainId) => this.updateChain(chainId, hubPoolTokens))
    );

    balanceInfo.forEach((tokenData, idx) => {
      const chainId = chainIds[idx];
      for (const token of Object.keys(tokenData)) {
        assign(this.tokenData, [chainId, token], tokenData[token]);
      }
    });

    // Remove allowance from token data when logging.
    const balanceData = Object.fromEntries(
      Object.entries(this.tokenData).map(([chainId, tokenData]) => {
        return [
          chainId,
          Object.fromEntries(
            Object.entries(tokenData).map(([token, { balance }]) => {
              return [token, balance];
            })
          ),
        ];
      })
    );

    this.logger.debug({
      at: "TokenBalanceClient",
      message: `Updated TokenBalance client in ${getCurrentTime() - start} seconds.`,
      balanceData,
    });
  }

  async fetchTokenData(
    chainId: number,
    hubPoolTokens: L1Token[]
  ): Promise<Record<string, { balance: BigNumber; allowance: BigNumber }>> {
    const spokePoolClient = this.spokePoolClients[chainId];

    const { relayerAddress } = this;
    const tokenData = Object.fromEntries(
      await sdkUtils.mapAsync(this.resolveRemoteTokens(chainId, hubPoolTokens), async (token: Contract) => {
        const balance: BigNumber = await token.balanceOf(relayerAddress);
        const allowance = await this._getAllowance(spokePoolClient, token);
        return [token.address, { balance, allowance }];
      })
    );

    return tokenData;
  }

  private _getAllowanceCacheKey(spokePoolClient: SpokePoolClient, originToken: string): string {
    const { chainId, spokePool } = spokePoolClient;
    return `l2TokenAllowance_${chainId}_${originToken}_${this.relayerAddress}_targetContract:${spokePool.address}`;
  }

  private async _getAllowance(spokePoolClient: SpokePoolClient, token: Contract): Promise<BigNumber> {
    const key = this._getAllowanceCacheKey(spokePoolClient, token.address);
    const redis = await this.getRedis();
    if (redis) {
      const result = await redis.get<string>(key);
      if (result !== null) {
        return toBN(result);
      }
    }
    const allowance: BigNumber = await token.allowance(this.relayerAddress, spokePoolClient.spokePool.address);
    if (allowance.gte(MAX_SAFE_ALLOWANCE) && redis) {
      // Save allowance in cache with no TTL as these should be exhausted.
      await redis.set(key, MAX_SAFE_ALLOWANCE);
    }
    return allowance;
  }

  _getBondTokenCacheKey(): string {
    return `bondToken_${this.hubPoolClient.hubPool.address}`;
  }

  private async _getBondToken(): Promise<string> {
    const redis = await this.getRedis();
    if (redis) {
      const cachedBondToken = await redis.get<string>(this._getBondTokenCacheKey());
      if (cachedBondToken !== null) {
        return cachedBondToken;
      }
    }
    const bondToken: string = await this.hubPoolClient.hubPool.bondToken();
    if (redis) {
      // The bond token should not change, and using the wrong bond token will be immediately obvious, so cache with
      // infinite TTL.
      await redis.set(this._getBondTokenCacheKey(), bondToken);
    }
    return bondToken;
  }

  protected async getRedis(): Promise<CachingMechanismInterface | undefined> {
    return getRedisCache(this.logger);
  }
}
