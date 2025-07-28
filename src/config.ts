// src/config.ts
export const SYMBOLS_TO_TRACK: string[] = [
    'BTCUSDT', // Bitcoin: ~$2.3T market cap, highest trading volume[](https://www.forbes.com/advisor/investing/cryptocurrency/top-10-cryptocurrencies/)
    'ETHUSDT', // Ethereum: ~$447.7B market cap, high volume[](https://www.forbes.com/advisor/investing/cryptocurrency/top-10-cryptocurrencies/)
    'BNBUSDT', // Binance Coin: ~$85.3B market cap, native to Binance[](https://www.investopedia.com/breaking-down-the-top-5-cryptocurrencies-by-market-cap-how-they-differ-and-why-11719642)
    'SOLUSDT', // Solana: High growth, DeFi leader, high volume[](https://zebpay.com/blog/top-10-cryptos-to-invest-in-2025)
    'XRPUSDT', // Ripple: ~$3.47 per coin, strong volume[](https://coindcx.com/blog/crypto-highlights/top-10-cryptos-2025/)
    'DOGEUSDT', // Dogecoin: High popularity, ETF potential[](https://coindcx.com/blog/crypto-highlights/top-10-cryptos-2025/)
    'ADAUSDT', // Cardano: ~$0.875 per coin, growing DeFi[](https://coindcx.com/blog/crypto-highlights/top-10-cryptos-2025/)
    'TRXUSDT', // Tron: ~$0.311 per coin, scalable blockchain[](https://coindcx.com/blog/crypto-highlights/top-10-cryptos-2025/)
    'AVAXUSDT', // Avalanche: Scalable, DeFi-focused
    'SHIBUSDT', // Shiba Inu: ~$5B market cap, meme coin popularity[](https://staxpayments.com/blog/most-popular-cryptocurrencies/)
    'LINKUSDT', // Chainlink: Oracle network, strong volume
    'LTCUSDT', // Litecoin: Established, high liquidity
    'DOTUSDT', // Polkadot: Interoperability-focused
    'MATICUSDT', // Polygon: Layer-2 scaling
    'NEARUSDT', // NEAR Protocol: Scalable blockchain
    'UNIUSDT', // Uniswap: Leading DeFi DEX
    'ICPUSDT', // Internet Computer: Decentralized cloud
    'APTUSDT', // Aptos: High-throughput blockchain
    'SUIUSDT', // Sui: Layer-1 blockchain
    'FETUSDT', // Fetch.ai: AI-focused crypto
    'RNDRUSDT', // Render Token: GPU rendering
    'HBARUSDT', // Hedera: Enterprise-grade blockchain
    'XLMUSDT', // Stellar: Cross-border payments
    'INJUSDT', // Injective: DeFi trading protocol
    'THETAUSDT', // Theta: Video streaming blockchain
    'IMXUSDT', // Immutable X: NFT scaling
    'AAVEUSDT', // Aave: DeFi lending
    'FILUSDT', // Filecoin: Decentralized storage
    'OPUSDT', // Optimism: Ethereum layer-2
    'ARBUSDT', // Arbitrum: Ethereum layer-2
    'MKRUSDT', // Maker: Stablecoin governance
    'FTMUSDT', // Fantom: High-speed blockchain
    'GRTUSDT', // The Graph: Data indexing
    'RUNEUSDT', // THORChain: Cross-chain DEX
    'ALGOUSDT', // Algorand: Scalable blockchain
    'EGLDUSDT', // MultiversX: High-throughput blockchain
    'KAVAUSDT', // Kava: DeFi platform
    'AXSUSDT', // Axie Infinity: Play-to-earn gaming[](https://coinmarketcap.com/)
    'SEIUSDT', // Sei: High-speed layer-1
    'GALAUSDT', // Gala: Gaming and NFTs
    'SANDUSDT', // The Sandbox: Metaverse gaming
    'MANAUSDT', // Decentraland: Metaverse
    'CHZUSDT', // Chiliz: Sports and entertainment
    'ENJUSDT', // Enjin: Gaming and NFTs
    'BCHUSDT', // Bitcoin Cash: Peer-to-peer cash
    'EOSUSDT', // EOS: DApp platform
    'XMRUSDT', // Monero: Privacy-focused
    'NEOUSDT', // NEO: Smart contract platform
    'IOTAUSDT', // IOTA: IoT-focused blockchain
    'ZECUSDT', // Zcash: Privacy-focused
    'PEPEUSDT', // Pepe: Meme coin, high volume
    'WLDUSDT', // Worldcoin: Identity-focused
    'TIAUSDT', // Celestia: Modular blockchain
    'PENDLEUSDT', // Pendle: DeFi yield protocol
    'CRVUSDT', // Curve DAO: Stablecoin DEX
    '1INCHUSDT', // 1inch: DEX aggregator
    'COMPUSDT', // Compound: DeFi lending
    'LDOUSDT', // Lido: Liquid staking
    'KNCUSDT', // Kyber Network: Liquidity protocol
    'OCEANUSDT', // Ocean Protocol: Data marketplace
    'ZILUSDT', // Zilliqa: Sharded blockchain
    'ZRXUSDT', // 0x: DEX protocol
    'SKLUSDT', // SKALE: Ethereum scaling
    'QTUMUSDT', // Qtum: Smart contract platform
    'ONTUSDT', // Ontology: Data exchange
    'IOSTUSDT', // IOST: Scalable blockchain
    'WAVESUSDT', // Waves: DApp platform
    'HNTUSDT', // Helium: IoT network
    'BLURUSDT', // Blur: NFT marketplace
    'ALICEUSDT', // MyNeighborAlice: Blockchain gaming
    'ANKRUSDT', // Ankr: Web3 infrastructure
    'ARPAUSDT', // ARPA: Privacy computation
    'ASTRUSDT', // Astar: Polkadot parachain
    'COTIUSDT', // COTI: Payment network
    'DYDXUSDT', // dYdX: Decentralized exchange
    'ENSUSDT', // Ethereum Name Service: Domain names
    'JASMYUSDT', // Jasmy: IoT and data
    'LRCUSDT', // Loopring: Layer-2 DEX
    'MEMEUSDT', // Memecoin: Meme-based token
    'NOTUSDT', // Notcoin: Telegram-based token
    'OMGUSDT', // OMG Network: Layer-2 scaling
    'ONEUSDT', // Harmony: Sharded blockchain
    'RAYUSDT', // Raydium: Solana-based DEX
    'REEFUSDT', // Reef: DeFi platform
    'ROSEUSDT', // Oasis Network: Privacy-focused
    'RVNUSDT', // Ravencoin: Asset transfer
    'STXUSDT', // Stacks: Bitcoin smart contracts
    'SUPERUSDT', // SuperVerse: Gaming and NFTs
    'TFUELUSDT', // Theta Fuel: Video streaming
    'UNFIUSDT', // Unifi Protocol: DeFi interoperability
    'XTZUSDT', // Tezos: Self-upgrading blockchain
    'YFIUSDT', // Yearn.finance: DeFi yield aggregator
    'ZENUSDT', // Horizen: Privacy-focused
    'BEAMUSDT', // Beam: Gaming blockchain
    'FLOWUSDT', // Flow: NFT and gaming
    'CAKEUSDT', // PancakeSwap: DeFi DEX
    'CFXUSDT'  // Conflux: High-throughput blockchain
];