# zkLink Relayer

This code is a fork of [Across V3 Relayer](https://github.com/across-protocol/relayer) and interacts with zkLink's smart contracts.

## How to run a Relayer

Check out [this guide](./running-a-relayer.md) for detailed bot instructions!

## Prerequisites

After installing dependencies and building the repository, be sure to [install RedisDB](https://redis.io/docs/getting-started/installation/), an in-memory storage layer that is required to make the bots work. The bots query blockchain RPCs for a lot of smart contract events so it's important that the bot
cache some of this data in order to maintain its speed.

The first time that the bot runs, it might be slower than usual as the Redis DB fills up. This slowdown should disappear on subsequent runs.

Start the `redis` server in a separate window:

```sh
redis-server
```

## Installation

```sh
# install dependencies
cd relayer
yarn install

# build relayer bot
yarn build
```

# License

All files within this repository are licensed under the [GNU Affero General Public License](LICENCE) unless stated otherwise.

# Developers

## Contributing

```sh
# run test suite
yarn test

# apply stylistic changes (e.g. eslint and prettier)
yarn lint-fix
```

Read through [CONTRIBUTING.md](https://github.com/UMAprotocol/protocol/blob/master/CONTRIBUTING.md) for a general overview of our contribution process. These guidelines are shared between the UMA and Across codebases because they were built originally by the same teams.
