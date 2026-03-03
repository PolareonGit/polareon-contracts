import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Upgrading with account:", deployer.address);
  console.log("Network:", network.name);

  // Load current deployment
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(deploymentsDir, `${network.name}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No deployment found for network: ${network.name}. Deploy first.`,
    );
  }

  const deployment = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const proxyAddress = deployment.proxy;
  console.log("Proxy address:", proxyAddress);

  // Deploy new implementation
  const PolareonTokenPool = await ethers.getContractFactory(
    "PolareonTokenPool",
  );

  console.log("\nUpgrading PolareonTokenPool implementation...");
  const upgraded = await upgrades.upgradeProxy(
    proxyAddress,
    PolareonTokenPool,
    {
      kind: "uups",
    },
  );

  await upgraded.waitForDeployment();
  const newImplAddress = await upgrades.erc1967.getImplementationAddress(
    proxyAddress,
  );

  console.log("✅ Upgraded! New implementation at:", newImplAddress);

  // Update deployment info
  deployment.implementation = newImplAddress;
  deployment.lastUpgrade = new Date().toISOString();
  deployment.upgradeBlockNumber = await ethers.provider.getBlockNumber();
  fs.writeFileSync(filePath, JSON.stringify(deployment, null, 2));
  console.log(`📄 Deployment info updated: deployments/${network.name}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
