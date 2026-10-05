// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 H2O.ai, Inc.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract DeployScriptTest is Test {
    Deploy internal script = new Deploy();

    function test_refusesMainnets() public {
        uint256[6] memory mainnets = [uint256(1), 8453, 10, 42161, 137, 56];
        for (uint256 i = 0; i < mainnets.length; ++i) {
            assertFalse(script.isAllowedTestChain(mainnets[i]));
            vm.chainId(mainnets[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.MainnetRefused.selector, mainnets[i]));
            script.run();
        }
    }

    function test_allowsDevnetAndTestnets() public view {
        assertTrue(script.isAllowedTestChain(31337));
        assertTrue(script.isAllowedTestChain(84532));
        assertTrue(script.isAllowedTestChain(11155111));
    }
}
