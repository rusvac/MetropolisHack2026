// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestPool} from "../src/TestPool.sol";

// no forge-std: plain require checks, so the project needs no submodule

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract Stranger {
    function add(TestPool pool) external payable {
        pool.addLiquidity{value: msg.value}(0);
    }

    function remove(TestPool pool) external {
        pool.removeLiquidity(1, 0, address(this));
    }
}

contract TestPoolTest {
    TestPool pool;
    MockUSDC usdc;

    receive() external payable {}

    function setUp() public {
        usdc = new MockUSDC();
        pool = new TestPool(address(usdc), 30);
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(pool), type(uint256).max);
        pool.addLiquidity{value: 0.8 ether}(5e6);
    }

    function test_seed() public view {
        (uint256 m, uint256 u) = pool.getReserves();
        require(m == 0.8 ether && u == 5e6, "reserves");
        require(address(pool).balance == 0.8 ether, "mon balance");
        require(usdc.balanceOf(address(pool)) == 5e6, "usdc balance");
    }

    function test_monForUsdc() public {
        uint256 k0 = pool.reserveMon() * pool.reserveUsdc();
        uint256 quoted = pool.getAmountOut(0.01 ether, true);
        uint256 before = usdc.balanceOf(address(this));
        uint256 out = pool.swapMonForUsdc{value: 0.01 ether}(quoted, address(this));
        require(out == quoted && out > 0, "out");
        require(usdc.balanceOf(address(this)) - before == out, "received");
        require(pool.reserveMon() * pool.reserveUsdc() >= k0, "k");
        // 0.01 MON at 6.25 USDC per MON, less 0.3% fee and the price move
        require(out < 62_500 && out > 60_000, "price");
    }

    function test_usdcForMon() public {
        uint256 k0 = pool.reserveMon() * pool.reserveUsdc();
        uint256 quoted = pool.getAmountOut(0.5e6, false);
        uint256 before = address(this).balance;
        uint256 out = pool.swapUsdcForMon(0.5e6, quoted, address(this));
        require(out == quoted && out > 0, "out");
        require(address(this).balance - before == out, "received");
        require(pool.reserveMon() * pool.reserveUsdc() >= k0, "k");
        require(address(pool).balance == pool.reserveMon(), "mon tracked");
        require(usdc.balanceOf(address(pool)) == pool.reserveUsdc(), "usdc tracked");
    }

    function test_slippageReverts() public {
        uint256 quoted = pool.getAmountOut(0.01 ether, true);
        try pool.swapMonForUsdc{value: 0.01 ether}(quoted + 1, address(this)) {
            revert("should revert");
        } catch {}
    }

    function test_zeroReverts() public {
        try pool.swapUsdcForMon(0, 0, address(this)) {
            revert("should revert");
        } catch {}
    }

    function test_onlyOwnerSeedsAndRemoves() public {
        Stranger s = new Stranger();
        try s.add{value: 1}(pool) {
            revert("stranger added");
        } catch {}
        try s.remove(pool) {
            revert("stranger removed");
        } catch {}
    }

    function test_removeReprices() public {
        pool.removeLiquidity(0.4 ether, 0, address(this));
        (uint256 m, uint256 u) = pool.getReserves();
        require(m == 0.4 ether && u == 5e6, "reserves after remove");
    }

    function test_twoHalvesBeatOneWhole() public {
        TestPool other = new TestPool(address(usdc), 30);
        usdc.approve(address(other), type(uint256).max);
        other.addLiquidity{value: 0.8 ether}(5e6);
        uint256 whole = pool.getAmountOut(1e6, false);
        uint256 halves = pool.getAmountOut(0.5e6, false) + other.getAmountOut(0.5e6, false);
        require(halves > whole, "split");
    }
}
