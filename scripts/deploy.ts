import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Network:",
    network.name,
    "| Chain ID:",
    (await ethers.provider.getNetwork()).chainId.toString(),
  );

  // --- Configuration ---
  const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS;
  const SAFE_MULTISIG_ADDRESS = process.env.SAFE_MULTISIG_ADDRESS;

  if (!OPERATOR_ADDRESS) {
    throw new Error("OPERATOR_ADDRESS env var is required");
  }
  if (!SAFE_MULTISIG_ADDRESS) {
    throw new Error("SAFE_MULTISIG_ADDRESS env var is required");
  }

  console.log("Owner (Safe multisig):", SAFE_MULTISIG_ADDRESS);
  console.log("Operator EOA:", OPERATOR_ADDRESS);

  // --- Deploy UUPS proxy ---
  const PolareonTokenPool = await ethers.getContractFactory(
    "PolareonTokenPool",
  );

  console.log("\nDeploying PolareonTokenPool (UUPS proxy)...");
  const proxy = await upgrades.deployProxy(
    PolareonTokenPool,
    [SAFE_MULTISIG_ADDRESS, OPERATOR_ADDRESS],
    {
      initializer: "initialize",
      kind: "uups",
    },
  );

  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  const implAddress = await upgrades.erc1967.getImplementationAddress(
    proxyAddress,
  );

  console.log("✅ Proxy deployed to:", proxyAddress);
  console.log("   Implementation at:", implAddress);

  // --- Save deployment info ---
  const deploymentInfo = {
    network: network.name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    proxy: proxyAddress,
    implementation: implAddress,
    owner: SAFE_MULTISIG_ADDRESS,
    operator: OPERATOR_ADDRESS,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    blockNumber: await ethers.provider.getBlockNumber(),
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filePath = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2));
  console.log(
    `\n📄 Deployment info saved to: deployments/${network.name}.json`,
  );

  console.log("\n🔑 Next steps:");
  console.log(
    `   1. Verify on Basescan: npm run verify:${
      network.name === "baseSepolia" ? "sepolia" : "base"
    }`,
  );
  console.log("   2. Export ABIs: npm run export-abi");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
