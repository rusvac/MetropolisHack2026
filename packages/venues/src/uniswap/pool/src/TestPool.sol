// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title TestPool
/// @notice a constant-product pool of native MON against one ERC-20 (Circle's USDC on Monad testnet).
/// spidereum's second executing venue on Monad testnet, because Uniswap v4 has no testnet deployment.
/// this is a test pool, not Uniswap. the owner seeds and re-prices it. anyone can swap.
contract TestPool {
    IERC20Min public immutable usdc;
    /// @notice swap fee in basis points, taken from the amount in
    uint16 public immutable feeBps;
    address public owner;

    /// @notice reserves are tracked, not read from balances, so a stray transfer does not move the price
    uint256 public reserveMon;
    uint256 public reserveUsdc;

    uint256 private unlocked = 1;

    event Swap(address indexed sender, address indexed to, bool monIn, uint256 amountIn, uint256 amountOut);
    event Sync(uint256 reserveMon, uint256 reserveUsdc);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error Locked();
    error ZeroAmount();
    error NoLiquidity();
    error Slippage(uint256 amountOut, uint256 minOut);
    error TransferFailed();
    error BadFee();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address usdc_, uint16 feeBps_) {
        if (feeBps_ >= 10_000) revert BadFee();
        usdc = IERC20Min(usdc_);
        feeBps = feeBps_;
        owner = msg.sender;
        emit OwnerChanged(msg.sender);
    }

    /// @notice the output for `amountIn`, after the fee, at the current reserves
    function getAmountOut(uint256 amountIn, bool monIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = monIn ? (reserveMon, reserveUsdc) : (reserveUsdc, reserveMon);
        if (rIn == 0 || rOut == 0) return 0;
        uint256 inAfterFee = amountIn * (10_000 - feeBps);
        return (inAfterFee * rOut) / (rIn * 10_000 + inAfterFee);
    }

    function getReserves() external view returns (uint256 mon, uint256 usdcAmount) {
        return (reserveMon, reserveUsdc);
    }

    /// @notice sell msg.value MON for USDC, sent to `to`
    function swapMonForUsdc(uint256 minOut, address to) external payable lock returns (uint256 amountOut) {
        if (msg.value == 0) revert ZeroAmount();
        amountOut = getAmountOut(msg.value, true);
        if (amountOut == 0) revert NoLiquidity();
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
        reserveMon += msg.value;
        reserveUsdc -= amountOut;
        _sendUsdc(to, amountOut);
        emit Swap(msg.sender, to, true, msg.value, amountOut);
        emit Sync(reserveMon, reserveUsdc);
    }

    /// @notice sell `amountIn` USDC for MON, sent to `to`. needs an approval for `amountIn` first
    function swapUsdcForMon(uint256 amountIn, uint256 minOut, address to) external lock returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        amountOut = getAmountOut(amountIn, false);
        if (amountOut == 0) revert NoLiquidity();
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
        _pullUsdc(msg.sender, amountIn);
        reserveUsdc += amountIn;
        reserveMon -= amountOut;
        _sendMon(to, amountOut);
        emit Swap(msg.sender, to, false, amountIn, amountOut);
        emit Sync(reserveMon, reserveUsdc);
    }

    /// @notice add msg.value MON and `usdcAmount` USDC. the ratio of the first add sets the price
    function addLiquidity(uint256 usdcAmount) external payable onlyOwner lock {
        if (usdcAmount > 0) _pullUsdc(msg.sender, usdcAmount);
        reserveMon += msg.value;
        reserveUsdc += usdcAmount;
        emit Sync(reserveMon, reserveUsdc);
    }

    /// @notice take reserves out. with addLiquidity, this re-prices the pool
    function removeLiquidity(uint256 monAmount, uint256 usdcAmount, address to) external onlyOwner lock {
        reserveMon -= monAmount;
        reserveUsdc -= usdcAmount;
        if (usdcAmount > 0) _sendUsdc(to, usdcAmount);
        if (monAmount > 0) _sendMon(to, monAmount);
        emit Sync(reserveMon, reserveUsdc);
    }

    function setOwner(address next) external onlyOwner {
        owner = next;
        emit OwnerChanged(next);
    }

    function _pullUsdc(address from, uint256 amount) private {
        (bool ok, bytes memory ret) =
            address(usdc).call(abi.encodeCall(IERC20Min.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _sendUsdc(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _sendMon(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
