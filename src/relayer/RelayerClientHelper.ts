import { utils as sdkUtils } from "@across-protocol/sdk";
import winston from "winston";
import {
  HubPoolClient,
  InventoryClient,
  ProfitClient,
  TokenClient,
} from "../clients";
import { IndexedSpokePoolClient, IndexerOpts } from "../clients/SpokePoolClient";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateSpokePoolClients,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import { getBlockForTimestamp, getCurrentTime, getProvider, getRedisCache, Signer } from "../utils";
import { typechain } from "@across-protocol/sdk";
import { RelayerConfig } from "./RelayerConfig";

export interface RelayerClients extends Clients {
  spokePoolClients: SpokePoolClientsByChain;
  tokenClient: TokenClient;
  profitClient: ProfitClient;
  inventoryClient: InventoryClient;
}

async function indexedSpokePoolClient(
  baseSigner: Signer,
  hubPoolClient: HubPoolClient,
  chainId: number,
  opts: IndexerOpts & { lookback: number; blockRange: number; spokePoolAddr: string; registrationBlock: number }
): Promise<IndexedSpokePoolClient> {
  const { logger } = hubPoolClient;

  // Set up Spoke signers and connect them to spoke pool contract objects.
  const signer = baseSigner.connect(await getProvider(chainId));
  const spokePoolAddr = opts.spokePoolAddr;

  const blockFinder = undefined;
  const redis = await getRedisCache(hubPoolClient.logger);
  const [activationBlock, fromBlock] = await Promise.all([
    opts.registrationBlock,
    getBlockForTimestamp(chainId, getCurrentTime() - opts.lookback, blockFinder, redis),
  ]);

  const spokePoolClient = new IndexedSpokePoolClient(
    logger,
    typechain.SpokePool__factory.connect(spokePoolAddr, signer),
    null,
    chainId,
    activationBlock,
    { fromBlock, maxBlockLookBack: opts.blockRange },
    opts.lookback,
    opts
  );

  return spokePoolClient;
}

export async function constructRelayerClients(
  logger: winston.Logger,
  config: RelayerConfig,
  baseSigner: Signer
): Promise<RelayerClients> {
  const signerAddr = await baseSigner.getAddress();
  // The relayer only uses the HubPoolClient to query repayments refunds for the latest validated
  // bundle and the pending bundle. 8 hours should cover the latest two bundles on production in
  // almost all cases. Look back to genesis on testnets.
  const hubPoolLookBack = 3600 * 8;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookBack);
  const { hubPoolClient } = commonClients;

  // If both origin and destination chains are configured, then limit the SpokePoolClients instantiated to the
  // sum of them. Otherwise, do not specify the chains to be instantiated to inherit one SpokePoolClient per
  // enabled chain.
  const enabledChains =
    config.relayerOriginChains.length > 0 && config.relayerDestinationChains.length > 0
      ? sdkUtils.dedupArray([...config.relayerOriginChains, ...config.relayerDestinationChains])
      : undefined;

  let spokePoolClients: SpokePoolClientsByChain;
  if (config.externalIndexer) {
    spokePoolClients = Object.fromEntries(
      await sdkUtils.mapAsync(enabledChains, async (chainId) => {
        const finality = 0;
        const opts = {
          finality,
          spokePoolAddr: config.spokePoolConfig[chainId]["address"],
          lookback: config.maxRelayerLookBack,
          blockRange: config.maxBlockLookBack[chainId],
          registrationBlock: config.spokePoolConfig[chainId]["registrationBlock"]
        };
        return [chainId, await indexedSpokePoolClient(baseSigner, hubPoolClient, chainId, opts)];
      })
    );
  } else {
    spokePoolClients = await constructSpokePoolClientsWithLookback(
      logger,
      hubPoolClient,
      config,
      baseSigner,
      config.maxRelayerLookBack,
      enabledChains
    );
  }

  const tokenClient = new TokenClient(logger, signerAddr, spokePoolClients, hubPoolClient, config.hubpoolTokens);

  // If `relayerDestinationChains` is a non-empty array, then copy its value, otherwise default to all chains.
  const enabledChainIds = config.relayerDestinationChains.filter((chainId) => Object.keys(spokePoolClients).includes(chainId.toString()));
  const profitClient = new ProfitClient(
    logger,
    hubPoolClient,
    enabledChainIds,
    signerAddr,
    config.minRelayerFeePct,
    config.debugProfitability,
    config.relayerGasMultiplier,
    config.relayerMessageGasMultiplier,
    config.relayerGasPadding,
    config.fillTokens
  );

  const inventoryClient = new InventoryClient(
    signerAddr,
    logger,
    config.inventoryConfig,
    tokenClient,
    enabledChainIds,
    hubPoolClient
  );

  return { ...commonClients, spokePoolClients, tokenClient, profitClient, inventoryClient };
}

export async function updateRelayerClients(clients: RelayerClients, config: RelayerConfig): Promise<void> {
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.
  const { spokePoolClients } = clients;

  // TODO: the code below can be refined by grouping with promise.all. however you need to consider the inter
  // dependencies of the clients. some clients need to be updated before others. when doing this refactor consider
  // having a "first run" update and then a "normal" update that considers this. see previous implementation here
  // https://github.com/across-protocol/relayer/pull/37/files#r883371256 as a reference.
  await updateSpokePoolClients(spokePoolClients, [
    "IntentCreated",
    "IntentFilled",
  ]);

  // We can update the inventory client in parallel with checking for eth wrapping as these do not depend on each other.
  // Cross-chain deposit tracking produces duplicates in looping mode, so in that case don't attempt it. This does not
  // disable inventory management, but does make it ignorant of in-flight cross-chain transfers. The rebalancer is
  // assumed to run separately from the relayer and with pollingDelay 0, so it doesn't loop and will track transfers
  // correctly to avoid repeat rebalances.
  await Promise.all([
    config.sendingRelaysEnabled ? clients.tokenClient.setOriginTokenApprovals() : Promise.resolve(),
  ]);
}
