// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 H2O.ai, Inc.
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MarinaLicense} from "../src/MarinaLicense.sol";

/// @notice TESTNET-ONLY deployment of MarinaLicense.
///
/// The contract is chain-agnostic; this script is not. Until there is an explicit
/// go for production, it refuses every chain id that is not a known local devnet
/// or public testnet. Adding a mainnet here is a deliberate code change, not a flag.
///
/// The deployer signs with THEIR OWN key, chosen at the command line, e.g.
///   anvil:        forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
///                   --broadcast --private-key <anvil dev key>
///   Base Sepolia: forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org \
///                   --broadcast --account <your keystore account>
/// Marina never sees or stores the key. Env: LICENSE_ADMIN (defaults to the broadcaster),
/// LICENSE_URI (optional metadata URI).
contract Deploy is Script {
    error MainnetRefused(uint256 chainId);

    function isAllowedTestChain(uint256 id) public pure returns (bool) {
        return id == 31337 // anvil / hardhat devnet
            || id == 11155111 // Ethereum Sepolia
            || id == 560048 // Ethereum Hoodi
            || id == 84532 // Base Sepolia
            || id == 11155420 // OP Sepolia
            || id == 421614 // Arbitrum Sepolia
            || id == 80002; // Polygon Amoy
    }

    function run() external returns (MarinaLicense lic) {
        if (!isAllowedTestChain(block.chainid)) revert MainnetRefused(block.chainid);
        vm.startBroadcast();
        (, address broadcaster,) = vm.readCallers();
        address admin = vm.envOr("LICENSE_ADMIN", broadcaster);
        lic = new MarinaLicense(admin, vm.envOr("LICENSE_URI", string("")));
        vm.stopBroadcast();
        console2.log("MarinaLicense deployed", address(lic), "chain", block.chainid);
    }
}
