# Running a Relayer

## Requirements
The zkLink Relayer is implemented in Node.js and is capable of running on a variety of platforms. See the following table for platform recommendations.
| **Resource** | **Recommended**              |
|--------------|------------------------------|
| CPU          | 64-bit Dual Core @ 2+ GHz    |
| RAM          | 4GB                          |
| OS           | UNIX-like (GNU/Linux, MacOS) |

## Installation
```bash
# Clone relayer code with Github CLI or git clone.
git clone https://github.com/zksemi/across_relayer
cd across_relayer

# Establish environment file and restrict filesystem permissions.
cp .env.example .env
chmod 0600 .env

# The private key or seed phrase for the relayer can be stored in a
# dedicated file. Operators should be especially careful to set the file
# permissions correctly and to backup any secrets securely. The path to
# the secret is set via the SECRET env var (optionally specified in
# .env). The file may be stored anywhere in the file system but must be
# readable by the user that runs the relayer.
touch .secret
chown <user>:<group> .secret
chmod 0600 .secret
echo <private-key-or-mnemonic> > .secret
chmod 0400 .secret

# Install dependencies and build relayer.
# Nodejs and yarn are required.
yarn install
yarn build

# Run unit tests.
yarn test

# Apply any necessary changes to .env and mark it read-only.
chmod 0400 .env
```

## Updating
A helper script is available to automate updates. This performs the following actions:
- Flushes any existing installed dependencies.
- Pulls down the latest relayer commit.
- Installs all dependencies and builds the relayer.
- Displays the latest commit in the relayer-v3 repository.
### Important
This update helper is offered as a convenience. After update, the operator must manually verify that the update succeeded and that the commit shown matches the intended target.
```bash
yarn update
```

## Notes on requirements to RPC Providers
The relayer is dependent on querying historical blocks on each chain. The RPC provider must therefore support making archive queries. If the RPC provider cannot service archive queries then the relayer will fail with reports of obscure RPC errors.

## Using a Redis in-memory database to improve performance
The relayer queries a lot of events from each chain's RPC. Therefore, we use an in-memory database to improve performance and cache repeated RPC requests. Installation instructions can be found here. Once installed, run redis-server in one terminal window and then open another one to continue running the relayer from.

The redis server is used to cache the responses of RPC-intensive repetitive requests, like eth_getLogs, or internally-computed data like getBlockForTimestamp. Caching of data is subject to the age of the input response from the RPC provider, such that a minimum block age is required before it will be retained. This provides some protection against caching invalid data, or valid data becoming invalid (or otherwise changing) due to chain forks/re-orgs.

## Running the Relayer for the first time
Once you've installed and built the relayer code, the relayer will run in "simulation mode" meaning that it will simulate the transactions that would fill deposits, but will not submit them. This will give you a chance to review transactions before funds are sent.
When you feel ready to run the relayer and send your first relay, set SEND_RELAYS=true in .env to exit simulation mode!

## Which account will be used to send transactions?
When running with a MNEMONIC configured, the first account associated with the MNEMONIC set in the environment will be used. Be sure to add ETH and any token balances to its account so that it can send relays.
