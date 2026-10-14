// the slice of kuru's abis this venue calls. source: @kuru-labs/kuru-sdk 0.0.95, abi/*.json
import { parseAbi } from "viem";

export const orderBookAbi = parseAbi([
  // pricePrecision, sizePrecision, base, baseDecimals, quote, quoteDecimals, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps
  "function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)",
  "function bestBidAsk() view returns (uint256, uint256)",
  "function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function addBuyOrder(uint32 _price, uint96 size, bool _postOnly)",
  "function addSellOrder(uint32 _price, uint96 size, bool _postOnly)",
  "function batchCancelOrders(uint40[] _orderIds)",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
  "error InsufficientLiquidity()",
  "error MarketStateError()",
  "error NativeAssetInsufficient()",
  "error NativeAssetNotRequired()",
  "error NativeAssetTransferFail()",
  "error PriceError()",
  "error SizeError()",
  "error SlippageExceeded()",
  "error TickSizeError()",
  "error TooMuchSizeFilled()",
  "error PostOnlyError()",
  "error Unauthorized()",
]);

export const routerAbi = parseAbi([
  "function deployProxy(uint8 _type, address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread) returns (address)",
  "event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)",
]);

export const marginAccountAbi = parseAbi([
  "function deposit(address _user, address _token, uint256 _amount) payable",
  "function withdraw(uint256 _amount, address _token)",
  "function getBalance(address _user, address _token) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
