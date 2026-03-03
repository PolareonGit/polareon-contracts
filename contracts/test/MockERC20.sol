// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Simple ERC-20 mock for testing. Mints arbitrary amounts.
 */
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @dev Fee-on-transfer ERC-20 mock. Deducts 1% on every transfer.
 */
contract MockFeeToken is ERC20 {
    constructor() ERC20("FeeToken", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override {
        if (from != address(0) && to != address(0)) {
            // 1% fee burned on transfer
            uint256 fee = amount / 100;
            super._update(from, address(0), fee); // burn fee
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }
}
